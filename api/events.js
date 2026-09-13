/* eslint-env node */
// api/events.js
// Event picker. Events table in Airtable, filtered to one state.
//
//   GET /api/events?state=Texas
//   ->  [{ id, name, date, state, location, owner, prodOwner, swoogoId, status }]
//
// One Events table covers every year on purpose: linked-record fields point at
// exactly one table, so a per-year table could not link to that year's
// sponsorships.
//
// Two filters matter:
//   - Type = "Publication" marks Digital Issue / ad placeholder records dated
//     12/31. They are not events.
//   - No Swoogo Event ID means an unlinked leftover with a stale date, unless
//     Status is Planned (built in Airtable before it exists in Swoogo).
//
// Env: AIRTABLE_TOKEN (falls back to VITE_AIRTABLE_TOKEN)

const BASE = 'appSq5fIk7AM1KUo9';
const TABLE = 'tbl4YHWt1Ig1sHZ72';

const F = {
  name:      'fldHgQn3G3aS4PJHS',
  date:      'fldYTyJtcgLZNFjHZ',
  state:     'fldree76uox2Avfc9',
  location:  'fldn2sAqo0aBYumve',
  owner:     'fldD3hbaaCmxli05n', // Event Owner = the salesperson
  prodOwner: 'fldY6pCIj55CA9SXv', // Production Owner = Allison / Victoria / Kaitlyn
  swoogoId:  'fldNVKyb6IvR3dFtH',
  status:    'fldPIDCmHt4XusmyS',
  type:      'fldYJBi53NB8o5fDn',
};

const KEY = process.env.AIRTABLE_TOKEN || process.env.VITE_AIRTABLE_TOKEN;

async function getAll(tableId, fieldIds) {
  const out = [];
  let offset = '';
  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '100');
    qs.set('returnFieldsByFieldId', 'true');
    fieldIds.forEach((f) => qs.append('fields[]', f));
    if (offset) qs.set('offset', offset);

    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${tableId}?${qs}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `Airtable ${res.status}`);

    (data.records || []).forEach((r) => out.push({ id: r.id, ...r.fields }));
    offset = data.offset || '';
  } while (offset);
  return out;
}

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.name : v);

// Airtable date-only strings are UTC midnight = the previous day in Central.
function parseLocalDate(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export default async function handler(req, res) {
  if (!KEY) {
    return res.status(500).json({
      error: 'AIRTABLE_TOKEN not set — add it in Vercel Settings → Environment Variables',
    });
  }

  const state = req.query.state || 'Texas';

  try {
    const rows = await getAll(TABLE, Object.values(F));

    const events = rows
      .filter((r) => String(plain(r[F.state]) || '').toLowerCase() === state.toLowerCase())
      .filter((r) => plain(r[F.type]) !== 'Publication')
      .filter((r) => r[F.swoogoId] || plain(r[F.status]) === 'Planned')
      .map((r) => ({
        id:        r.id,
        name:      r[F.name] || '(untitled event)',
        date:      r[F.date] || null,
        state:     plain(r[F.state]) || '',
        location:  r[F.location] || '',
        owner:     plain(r[F.owner]) || '',
        prodOwner: plain(r[F.prodOwner]) || '',
        swoogoId:  r[F.swoogoId] || null,
        status:    plain(r[F.status]) || '',
      }))
      .sort((a, b) => {
        const da = parseLocalDate(a.date);
        const db = parseLocalDate(b.date);
        if (!da) return 1;
        if (!db) return -1;
        return da - db;
      });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(events);
  } catch (err) {
    console.error('events error:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
