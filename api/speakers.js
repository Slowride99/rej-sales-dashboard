/* eslint-env node */
// api/speakers.js
// Speaker view. Two lists.
//
//   GET /api/speakers?market=TX&swoogoId=1234&eventId=recXXXX
//   -> { committed, recommended, source }
//
//   committed    — confirmed speakers from SWOOGO, the source of truth.
//                  Falls back to the legacy txspeakers Airtable table when no
//                  Swoogo ID is linked on the event.
//   recommended  — scored from five years of archive speaking history,
//                  with anyone already confirmed removed.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      SWOOGO_CONSUMER_KEY, SWOOGO_CONSUMER_SECRET, AIRTABLE_TOKEN

import { createClient } from '@supabase/supabase-js';
import { eventBundle } from './swoogo.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AT_BASE = 'appSq5fIk7AM1KUo9';
const AT_KEY = process.env.AIRTABLE_TOKEN || process.env.VITE_AIRTABLE_TOKEN;

// Legacy fallback — predates the Swoogo migration.
const T_TXSPEAKERS = 'tbl46tg3hHbe9u6eZ';
const FS = {
  name:     'fldze60kjgRpNnFAz',
  company:  'fldXjad9r8CB3tWO2',
  headshot: 'fldGp3uHE4drWrc7S',
  events:   'fldo9eNvesOl72Fyz',
  email:    'fldeHf0w12CwOprCY',
};

async function airtableAll(tableId, fieldIds) {
  const out = [];
  let offset = '';
  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '100');
    qs.set('returnFieldsByFieldId', 'true');
    fieldIds.forEach((f) => qs.append('fields[]', f));
    if (offset) qs.set('offset', offset);

    const r = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${tableId}?${qs}`, {
      headers: { Authorization: `Bearer ${AT_KEY}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Airtable ${r.status}`);
    (data.records || []).forEach((rec) => out.push({ id: rec.id, ...rec.fields }));
    offset = data.offset || '';
  } while (offset);
  return out;
}

// Swoogo returns profile_picture either as a URL string or as an object with
// one, depending on how the image was attached.
function pic(p) {
  if (!p) return null;
  if (typeof p === 'string') return p;
  return p.url || p.file_url || p.thumbnail || null;
}

async function fromSwoogo(swoogoId) {
  const { speakers } = await eventBundle(swoogoId);
  return (speakers.items || []).map((sp) => ({
    id: `sw-${sp.id}`,
    name: [sp.first_name, sp.last_name].filter(Boolean).join(' ').trim() || '(unnamed)',
    title: sp.job_title || '',
    company: sp.company || '',
    email: sp.email || '',
    headshot: pic(sp.profile_picture),
  }));
}

async function fromAirtable(eventId) {
  if (!AT_KEY || !eventId) return [];
  const rows = await airtableAll(T_TXSPEAKERS, Object.values(FS));
  return rows
    .filter((r) => (r[FS.events] || []).includes(eventId))
    .map((r) => {
      const shot = r[FS.headshot];
      return {
        id: r.id,
        name: r[FS.name] || '(unnamed)',
        title: '',
        company: r[FS.company] || '',
        email: r[FS.email] || '',
        headshot: Array.isArray(shot) ? shot[0]?.url : null,
      };
    });
}

export default async function handler(req, res) {
  const market = req.query.market || 'TX';
  const swoogoId = req.query.swoogoId || null;
  const eventId = req.query.eventId || null;

  try {
    let source = 'none';

    const committedPromise = (async () => {
      if (swoogoId) {
        try {
          const list = await fromSwoogo(swoogoId);
          source = 'swoogo';
          // An event built in Swoogo but with no speakers entered yet should
          // still fall back rather than showing an empty column.
          if (list.length > 0) return list;
        } catch (e) {
          console.error('swoogo speakers failed, falling back:', e.message);
        }
      }
      const legacy = await fromAirtable(eventId).catch(() => []);
      if (legacy.length > 0) source = 'airtable';
      return legacy;
    })();

    const [committed, recRes] = await Promise.all([
      committedPromise,
      supabase.rpc('speaker_prospects', { p_market: market, p_limit: 60 }),
    ]);

    if (recRes.error) throw new Error(recRes.error.message);

    const taken = new Set(
      committed.map((c) => String(c.name || '').toLowerCase().trim()).filter(Boolean)
    );
    const recommended = (recRes.data || [])
      .filter((r) => !taken.has(String(r.name || '').toLowerCase().trim()))
      .slice(0, 40);

    return res.status(200).json({
      committed: committed.sort((a, b) => a.name.localeCompare(b.name)),
      recommended,
      source,
    });
  } catch (err) {
    console.error('speakers error:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
