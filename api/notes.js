/* eslint-env node */
// api/notes.js
// Shared event notes + the sales outreach log.
//
//   GET  /api/notes?eventId=recXXXX      -> { notes, outreach }
//   POST /api/notes  { kind: 'note',     eventId, companyId?, body, author, team, flag }
//   POST /api/notes  { kind: 'outreach', eventId, companyId?, subject, notes, channel,
//                      rep, outcome, nextStep, followUpBy }
//
// Two tables, deliberately separate:
//   Event Notes    — shared. Sales and production both read and write it.
//   Sales Outreach — sales only. Answers "when did I last contact this company".
// Production's own Communications table is untouched; that is materials
// chasing and does not belong in either of these.
//
// Env: AIRTABLE_TOKEN (falls back to VITE_AIRTABLE_TOKEN)

const BASE = 'appSq5fIk7AM1KUo9';
const KEY = process.env.AIRTABLE_TOKEN || process.env.VITE_AIRTABLE_TOKEN;

const T = {
  notes:    'tbl4gVJnzTiLfUFJy',
  outreach: 'tbllnZc8FI7lDc98z',
};

const F = {
  notes: {
    note:    'fldr26jOOcPAXXz1d',
    event:   'fldTdXozu5lcXshMj',
    company: 'fld9db94IU5oz9G2y',
    body:    'fld2YmomeomOmrEq8',
    author:  'fldvtUGA26i9DNZou',
    team:    'fldqkXGMzS80rKpxO',
    flag:    'fld5eD3Wyl8goe9Gr',
    created: 'fldXvfOIU69zW43ZA',
  },
  outreach: {
    title:      'fldClsTeQHpQLbyRG',
    company:    'flduVhK3M4o8ds4YV',
    event:      'fldajkHQ8EA89N49r',
    date:       'fldzkkPettsaWVxiB',
    channel:    'fldoXdJs7kVK9JIZn',
    rep:        'fld0ZHIJkCbCMmUMJ',
    subject:    'fld9KS6yYKDVlZkNj',
    notes:      'fldPNiZe3tlip8idr',
    outcome:    'fld5lMmAZLc5zrhUJ',
    nextStep:   'fldeTXmxdcwyDVn9O',
    followUpBy: 'fldgNRqUOw4qUyyKL',
    source:     'fldvMU7jWMlvKnrlT',
  },
};

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.name : v);

async function getAll(tableId, fieldIds) {
  const out = [];
  let offset = '';
  do {
    const qs = new URLSearchParams();
    qs.set('pageSize', '100');
    qs.set('returnFieldsByFieldId', 'true');
    fieldIds.forEach((f) => qs.append('fields[]', f));
    if (offset) qs.set('offset', offset);

    const r = await fetch(`https://api.airtable.com/v0/${BASE}/${tableId}?${qs}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Airtable ${r.status}`);
    (data.records || []).forEach((rec) => out.push({ id: rec.id, ...rec.fields }));
    offset = data.offset || '';
  } while (offset);
  return out;
}

async function create(tableId, fields) {
  const r = await fetch(
    `https://api.airtable.com/v0/${BASE}/${tableId}?returnFieldsByFieldId=true`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, typecast: true }),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Airtable ${r.status}`);
  return { id: data.id, ...data.fields };
}

// Local midnight, not UTC — an Airtable date-only string parsed as UTC is the
// previous day in Central.
function todayCentral() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

export default async function handler(req, res) {
  if (!KEY) return res.status(500).json({ error: 'AIRTABLE_TOKEN not set' });

  try {
    if (req.method === 'GET') {
      const eventId = req.query.eventId;
      const [notes, outreach] = await Promise.all([
        getAll(T.notes, Object.values(F.notes)),
        getAll(T.outreach, Object.values(F.outreach)),
      ]);

      const forEvent = (rows, evField) =>
        eventId ? rows.filter((r) => (r[evField] || []).includes(eventId)) : rows;

      return res.status(200).json({
        notes: forEvent(notes, F.notes.event)
          .map((n) => ({
            id: n.id,
            body: n[F.notes.body] || '',
            author: plain(n[F.notes.author]) || '',
            team: plain(n[F.notes.team]) || '',
            flag: plain(n[F.notes.flag]) || '',
            companyIds: n[F.notes.company] || [],
            created: n[F.notes.created] || null,
          }))
          .sort((a, b) => new Date(b.created) - new Date(a.created)),

        outreach: forEvent(outreach, F.outreach.event)
          .map((o) => ({
            id: o.id,
            date: o[F.outreach.date] || null,
            channel: plain(o[F.outreach.channel]) || '',
            rep: plain(o[F.outreach.rep]) || '',
            subject: o[F.outreach.subject] || '',
            notes: o[F.outreach.notes] || '',
            outcome: plain(o[F.outreach.outcome]) || '',
            nextStep: o[F.outreach.nextStep] || '',
            followUpBy: o[F.outreach.followUpBy] || null,
            source: plain(o[F.outreach.source]) || '',
            companyIds: o[F.outreach.company] || [],
          }))
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)),
      });
    }

    if (req.method === 'POST') {
      const b = req.body || {};

      // Linked records are a plain string array. [{id}] is the MCP shape and
      // fails silently here — 200 OK with nothing written.
      const link = (id) => (id ? [id] : undefined);

      if (b.kind === 'note') {
        if (!b.eventId || !b.body) {
          return res.status(400).json({ error: 'eventId and body are required' });
        }
        const rec = await create(T.notes, {
          [F.notes.event]: link(b.eventId),
          [F.notes.company]: link(b.companyId),
          [F.notes.body]: b.body,
          [F.notes.author]: b.author || undefined,
          [F.notes.team]: b.team || 'Sales',
          [F.notes.flag]: b.flag || 'FYI',
        });
        return res.status(200).json(rec);
      }

      if (b.kind === 'outreach') {
        if (!b.companyId) return res.status(400).json({ error: 'companyId is required' });
        const rec = await create(T.outreach, {
          [F.outreach.company]: link(b.companyId),
          [F.outreach.event]: link(b.eventId),
          [F.outreach.date]: b.date || todayCentral(),
          [F.outreach.channel]: b.channel || 'Email',
          [F.outreach.rep]: b.rep || undefined,
          [F.outreach.subject]: b.subject || '',
          [F.outreach.notes]: b.notes || '',
          [F.outreach.outcome]: b.outcome || undefined,
          [F.outreach.nextStep]: b.nextStep || '',
          [F.outreach.followUpBy]: b.followUpBy || undefined,
          [F.outreach.source]: b.source || 'Dashboard',
        });
        return res.status(200).json(rec);
      }

      return res.status(400).json({ error: "kind must be 'note' or 'outreach'" });
    }

    return res.status(405).json({ error: 'GET or POST only' });
  } catch (err) {
    console.error('notes error:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
