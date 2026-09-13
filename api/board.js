/* eslint-env node */
// api/board.js
// Everything the Sponsors view needs, in one round trip.
//
//   GET /api/board?market=TX&year=2026&eventId=recXXXXXXXXXXXXXX
//
//   -> { committed, prior, recommended }
//
// Who owns what:
//   Supabase  — five years of PheedLoop archive + the scoring functions
//   Airtable  — Companies (logos, websites, sponsor history), Sponsorships
//               (what's signed for this event), Contacts (who to email)
//
// Airtable Companies has 1,327 records with 100% logo coverage, so every
// column here gets a logo by matching on the normalised company key.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const AT_BASE = 'appSq5fIk7AM1KUo9';
const AT_KEY = process.env.AIRTABLE_TOKEN || process.env.VITE_AIRTABLE_TOKEN;

const T = {
  companies:    'tblKRzBETMQeK2NXJ',
  contacts:     'tbl6Yw7KSn3hBjn8m',
  sponsorships: 'tblvpB9XYNkFVSAnL',
};

const F = {
  companies: {
    name:        'fldsrDxMTXFUfT7se',
    logoUrl:     'fldU3vXVjliKZzrPx', // stable R2 link — NOT the attachment field,
                                      // whose URLs expire
    website:     'fldUMzgWkNJ5XLQcj',
    linkedin:    'fldKl3cBu2jUe13mD',
    lastSponsor: 'fldUBukFy4NteuXe5',
    history:     'fldjbBPbqfV30ISRC',
  },
  contacts: {
    name:    'fld512DWrGaLOOEP6',
    email:   'fldhJXOG3JmIwhKhx',
    primary: 'fld38GgSolIg8nayI',
  },
  sponsorships: {
    title:    'fldHe2bU8WEpwgRBc',
    company:  'fldofzxHkOmybkJhm',
    event:    'fldYQs6XvbQavGPvp',
    tier:     'fldVoroczOa7pj6Xc',
    contacts: 'fldrbKc2oExt7Ysoi',
    soldBy:   'fldyoMPA8IsW9eKNZ',
    signed:   'flddJOsmnjjaGvDPd',
    status:   'fldeb7jWmwDRoXVgt',
  },
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

const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v.name : v);

// Mirrors company_key() in Postgres. LEGAL SUFFIXES ONLY — stripping words like
// "Construction", "Partners", "Group" or "National" merges genuinely different
// companies (Capital Partners vs Capital Construction).
const LEGAL = /\b(inc|llc|l l c|ltd|lp|llp|plc|pllc|corp|corporation|co|company|group|holdings|holding)\s*$/;
function companyKey(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/\u00a0/g, ' ')
    .toLowerCase()
    .replace(/[.,&'"/()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i++) s = s.replace(LEGAL, '').trim();
  return s || null;
}

export default async function handler(req, res) {
  const market = req.query.market || 'TX';
  const year = Number(req.query.year) || new Date().getFullYear();
  const eventId = req.query.eventId || null;

  try {
    // The Airtable half can fail on its own (missing token, API hiccup)
    // without taking the archive columns down with it.
    const airtablePromise = (async () => {
      if (!AT_KEY) return { companies: [], contacts: [], sponsorships: [] };
      const [companies, contacts, sponsorships] = await Promise.all([
        airtableAll(T.companies, Object.values(F.companies)),
        airtableAll(T.contacts, Object.values(F.contacts)),
        airtableAll(T.sponsorships, Object.values(F.sponsorships)),
      ]);
      return { companies, contacts, sponsorships };
    })().catch((e) => {
      console.error('airtable error:', e.message);
      return { companies: [], contacts: [], sponsorships: [] };
    });

    const [at, priorRes, recRes] = await Promise.all([
      airtablePromise,
      supabase
        .from('company_signals')
        .select('key, display_name, times_sponsored, last_sponsored_year, attendee_count, events_attended, times_spoken, last_touch_year')
        .eq('market', market)
        .neq('key', '__internal__')
        .gt('times_sponsored', 0)
        .order('last_sponsored_year', { ascending: false })
        .limit(80),
      supabase.rpc('sponsor_prospects', { p_market: market, p_year: year, p_limit: 80 }),
    ]);

    if (priorRes.error) throw new Error(`prior: ${priorRes.error.message}`);
    if (recRes.error) throw new Error(`recommended: ${recRes.error.message}`);

    // Company lookup by normalised key — logos, websites, sponsor history.
    const byKey = {};
    at.companies.forEach((c) => {
      const k = companyKey(c[F.companies.name]);
      if (k && !byKey[k]) {
        byKey[k] = {
          logo:        c[F.companies.logoUrl] || null,
          website:     c[F.companies.website] || null,
          linkedin:    c[F.companies.linkedin] || null,
          lastSponsor: c[F.companies.lastSponsor] || null,
          history:     c[F.companies.history] || null,
          airtableId:  c.id,
        };
      }
    });
    const enrich = (r) => ({ ...r, ...(byKey[r.key] || {}) });

    // --- committed: what's signed for THIS event ---
    const byCompanyId = Object.fromEntries(at.companies.map((c) => [c.id, c]));
    const byContactId = Object.fromEntries(at.contacts.map((c) => [c.id, c]));

    const committed = eventId
      ? at.sponsorships
          .filter((s) => (s[F.sponsorships.event] || []).includes(eventId))
          .map((s) => {
            const co = byCompanyId[(s[F.sponsorships.company] || [])[0]] || {};
            const people = (s[F.sponsorships.contacts] || [])
              .map((id) => byContactId[id])
              .filter(Boolean)
              .map((c) => ({
                name: c[F.contacts.name],
                email: c[F.contacts.email],
                primary: !!c[F.contacts.primary],
              }));
            const name = co[F.companies.name] || '';
            return {
              id:       s.id,
              company:  name || s[F.sponsorships.title] || '(unnamed)',
              key:      companyKey(name),
              logo:     co[F.companies.logoUrl] || null,
              website:  co[F.companies.website] || '',
              tier:     plain(s[F.sponsorships.tier]) || '',
              status:   plain(s[F.sponsorships.status]) || '',
              soldBy:   plain(s[F.sponsorships.soldBy]) || '',
              signed:   !!s[F.sponsorships.signed],
              contacts: people,
            };
          })
          .sort((a, b) => a.company.localeCompare(b.company))
      : [];

    const committedKeys = new Set(committed.map((c) => c.key).filter(Boolean));

    // sponsor_prospects() already drops anyone with an archive sponsor record
    // for the target year. This second pass drops anyone signed for THIS event
    // in Airtable, which the archive does not know about.
    const recommended = (recRes.data || [])
      .filter((r) => !committedKeys.has(r.key))
      .slice(0, 40)
      .map(enrich);

    const prior = (priorRes.data || [])
      .filter((r) => !committedKeys.has(r.key))
      .slice(0, 40)
      .map(enrich);

    return res.status(200).json({
      committed,
      prior,
      recommended,
      meta: { companiesMatched: Object.keys(byKey).length },
    });
  } catch (err) {
    console.error('board error:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
