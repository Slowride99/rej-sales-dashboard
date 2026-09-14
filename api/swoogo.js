/* eslint-env node */
// api/swoogo.js
// Swoogo proxy for the sales dashboard. Swoogo is the source of truth for
// event identity, speakers, sessions and the public sponsor list.
//
//   GET /api/swoogo?action=events        -> events for pickers
//   GET /api/swoogo?action=event&id=123  -> event + speakers + sponsors + sessions
//
// NOTE the pagination parameter is `per-page` WITH A HYPHEN. `per_page` is
// silently ignored and everything comes back in twenties — which looks like a
// Swoogo cap but is really a typo.
//
// Env: SWOOGO_CONSUMER_KEY, SWOOGO_CONSUMER_SECRET

const SWOOGO_BASE = 'https://api.swoogo.com/api/v1';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;

  const key = process.env.SWOOGO_CONSUMER_KEY;
  const secret = process.env.SWOOGO_CONSUMER_SECRET;
  if (!key || !secret) {
    throw new Error('Missing SWOOGO_CONSUMER_KEY / SWOOGO_CONSUMER_SECRET');
  }

  const basic = Buffer.from(`${key}:${secret}`).toString('base64');
  const resp = await fetch(`${SWOOGO_BASE}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!resp.ok) throw new Error(`Swoogo token failed (${resp.status}): ${await resp.text()}`);

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 1800) * 1000;
  return cachedToken;
}

async function swoogoGet(path, params = {}) {
  const token = await getToken();
  const qs = new URLSearchParams(params).toString();
  const opts = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };

  let resp = await fetch(`${SWOOGO_BASE}${path}${qs ? `?${qs}` : ''}`, opts);
  if (resp.status === 401) {
    cachedToken = null;
    opts.headers.Authorization = `Bearer ${await getToken()}`;
    resp = await fetch(`${SWOOGO_BASE}${path}${qs ? `?${qs}` : ''}`, opts);
  }
  if (!resp.ok) {
    const err = new Error(`Swoogo GET ${path} (${resp.status}): ${await resp.text()}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function swoogoGetAll(path, params = {}) {
  const first = await swoogoGet(path, { ...params, page: 1 });
  const items = [...(first.items || [])];
  const pages = first._meta?.pageCount || 1;
  for (let p = 2; p <= pages; p++) {
    const next = await swoogoGet(path, { ...params, page: p });
    items.push(...(next.items || []));
  }
  return { items, _meta: first._meta };
}

export async function eventBundle(id) {
  const [speakers, sponsors, sessions] = await Promise.all([
    swoogoGetAll('/speakers.json', {
      event_id: id,
      'per-page': 100,
      fields: 'id,first_name,last_name,company,job_title,profile_picture,event_sort,email',
    }).catch(() => ({ items: [] })),
    swoogoGetAll('/sponsors.json', {
      event_id: id,
      'per-page': 100,
      fields: 'id,name,level,logo_id,website',
    }).catch(() => ({ items: [] })),
    swoogoGetAll('/sessions.json', {
      event_id: id,
      'per-page': 100,
      fields: 'id,name,date,start_time,end_time,speakers',
      expand: 'speakers',
    }).catch(() => ({ items: [] })),
  ]);

  if (Array.isArray(speakers.items)) {
    speakers.items.sort(
      (a, b) =>
        (a.event_sort ?? 999) - (b.event_sort ?? 999) ||
        (a.last_name || '').localeCompare(b.last_name || '')
    );
  }
  return { speakers, sponsors, sessions };
}

export default async function handler(req, res) {
  const { action, id } = req.query;
  try {
    if (action === 'events') {
      const data = await swoogoGetAll('/events.json', {
        fields: 'id,name,url,domain,start_date,end_date,status',
        'per-page': 100,
      });
      return res.status(200).json(data);
    }

    if (action === 'event') {
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const [event, bundle] = await Promise.all([
        swoogoGet(`/events/${id}.json`, { expand: 'location' }),
        eventBundle(id),
      ]);
      return res.status(200).json({ event, ...bundle });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('swoogo error:', err.message);
    return res.status(err.status === 401 || err.status === 403 ? 502 : 500)
      .json({ error: err.message });
  }
}
