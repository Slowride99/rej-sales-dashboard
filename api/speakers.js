/* eslint-env node */
// api/speakers.js
// Speaker view. Two lists, same shape as the sponsors board.
//
//   GET /api/speakers?market=TX&eventId=recXXXXXXXXXXXXXX
//   -> { committed, recommended }
//
//   committed    — txspeakers rows linked to this event in Airtable
//   recommended  — scored people from five years of archive speaking history
//
// Headshots come from two places: Airtable attachments for committed speakers,
// and the R2 archive URL on speakers.picture for recommendations.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AIRTABLE_TOKEN

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AT_BASE = 'appSq5fIk7AM1KUo9';
const AT_KEY = process.env.AIRTABLE_TOKEN || process.env.VITE_AIRTABLE_TOKEN;

// txspeakers — Texas region speakers, linked to Events
const T_SPEAKERS = 'tbl46tg3hHbe9u6eZ';
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

export default async function handler(req, res) {
  const market = req.query.market || 'TX';
  const eventId = req.query.eventId || null;

  try {
    const committedPromise = (async () => {
      if (!AT_KEY || !eventId) return [];
      const rows = await airtableAll(T_SPEAKERS, Object.values(FS));
      return rows
        .filter((r) => (r[FS.events] || []).includes(eventId))
        .map((r) => {
          const shot = r[FS.headshot];
          return {
            id:       r.id,
            name:     r[FS.name] || '(unnamed)',
            company:  r[FS.company] || '',
            email:    r[FS.email] || '',
            headshot: Array.isArray(shot) ? shot[0]?.url : null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    })().catch((e) => {
      console.error('speakers committed error:', e.message);
      return [];
    });

    const [committed, recRes] = await Promise.all([
      committedPromise,
      supabase.rpc('speaker_prospects', { p_market: market, p_limit: 60 }),
    ]);

    if (recRes.error) throw new Error(recRes.error.message);

    // Drop anyone already confirmed for this event.
    const taken = new Set(committed.map((c) => c.name.toLowerCase().trim()));
    const recommended = (recRes.data || [])
      .filter((r) => !taken.has(String(r.name || '').toLowerCase().trim()))
      .slice(0, 40);

    return res.status(200).json({ committed, recommended });
  } catch (err) {
    console.error('speakers error:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
