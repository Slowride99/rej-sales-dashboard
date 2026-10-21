// api/notes.js — the part Todd is actually grading.
//
//   GET  /api/notes?series=<name>          -> { notes: { <key>: {body, updated_at} } }
//   POST /api/notes  {series,key,body}     -> { ok:true, updated_at }
//
// A note is keyed by (series, company key), so it follows the company on the
// board for that event and survives a materialised-view refresh — notes live in
// their own table, nothing in the pipeline touches them.
//
// An empty body deletes the note rather than storing a blank row, so Jeff
// clearing a field leaves no residue.
//
// Env (server-side only — no VITE_ prefix, these must never reach the browser):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;   // Vercel pre-parses
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  if (!SB || !SB_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  try {
    /* ------------------------------------------------------------ read ---- */
    if (req.method === 'GET') {
      const series = (req.query.series || '').trim();
      if (!series) return res.status(400).json({ error: 'series required' });

      const rows = await sb(
        `event_notes?series=eq.${encodeURIComponent(series)}` +
        '&select=company_key,body,updated_at&limit=2000'
      );

      const notes = {};
      for (const r of rows) notes[r.company_key] = { body: r.body, updated_at: r.updated_at };
      return res.json({ notes });
    }

    /* ----------------------------------------------------------- write ---- */
    if (req.method === 'POST') {
      const { series, key, body } = await readBody(req);
      if (!series || !key) return res.status(400).json({ error: 'series and key required' });

      const text = typeof body === 'string' ? body.trim() : '';

      // cleared field -> remove the row
      if (!text) {
        await sb(
          `event_notes?series=eq.${encodeURIComponent(series)}` +
          `&company_key=eq.${encodeURIComponent(key)}`,
          { method: 'DELETE' }
        );
        return res.json({ ok: true, updated_at: null, deleted: true });
      }

      const now = new Date().toISOString();
      const saved = await sb('event_notes?on_conflict=series,company_key', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify([{
          series,
          company_key: key,
          body: text.slice(0, 4000),
          updated_at: now,
        }]),
      });

      return res.json({ ok: true, updated_at: saved?.[0]?.updated_at || now });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
