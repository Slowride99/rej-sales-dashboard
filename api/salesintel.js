// api/salesintel.js — Vercel serverless function
//
// Two modes:
//   GET /api/salesintel?domain=cushwake.com
//       Enrich one company we already know about.
//
//   GET /api/salesintel?discover=1&state=TX&zip=75201&radius=25&naics=531210&limit=8
//       Find companies we have NO record of. Anything already in
//       company_domains is filtered out, so the panel only ever shows
//       genuinely new names.
//
// Everything is cached in Supabase. A repeat lookup costs nothing and,
// critically, still works if SalesIntel is down or has rate-limited us —
// which matters more on a demo day than freshness does.
//
// Env (server-side only — never prefix with VITE_):
//   SALESINTEL_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SI_BASE = 'https://api.salesintel.io/service/company';
const CACHE_DAYS = 30;          // firmographics barely move
const MAX_PAGE = 10;            // credits are per RECORD returned — keep small

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

/** Cached SalesIntel payload for a domain, or null if stale/absent. */
async function readCache(domain) {
  const rows = await sb(
    `salesintel_cache?domain=eq.${encodeURIComponent(domain)}&select=payload,fetched_at`
  );
  if (!rows?.length) return null;
  const age = (Date.now() - new Date(rows[0].fetched_at)) / 86400000;
  return { payload: rows[0].payload, stale: age > CACHE_DAYS };
}

async function writeCache(domain, payload) {
  await sb('salesintel_cache?on_conflict=domain', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ domain, payload, fetched_at: new Date().toISOString() }),
  }).catch(() => {});   // caching must never break the request
}

async function callSalesIntel(params) {
  const url = `${SI_BASE}?${new URLSearchParams(params)}`;
  const r = await fetch(url, {
    headers: {
      'X-CB-ApiKey': process.env.SALESINTEL_API_KEY,
      Accept: 'application/json',
    },
  });
  if (r.status === 429) {
    const e = new Error('salesintel_rate_limited');
    e.code = 429;
    throw e;
  }
  if (!r.ok) throw new Error(`salesintel ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** Flatten SalesIntel's nested shape into what the dashboard renders.
 *  Field names here are taken from a real /service/company response, not
 *  guessed — the previous version read company_domain, addresses[] and
 *  employee_count, none of which exist, so every record was silently dropped
 *  by the .filter(c => c.domain) below. */
function normalize(rec) {
  const c = rec.company || {};
  const loc = (rec.locations || []).find(l => l.is_ushq) || (rec.locations || [])[0] || {};

  const domain = (
    rec.primary_domain ||
    (rec.company_domains || [])[0] ||
    (c.domains || [])[0] || ''
  ).toLowerCase();

  // rec.location is a "Houston, TX" string — fallback when locations[] is absent
  const [locCity, locState] = String(rec.location || '').split(',').map(s => s.trim());

  return {
    name: rec.company_name || rec.primary_name || c.name || '',
    domain,
    industry: rec.industry || '',
    sector: rec.sector || '',
    employees: rec.company_size ?? c.size ?? null,
    employees_range: rec.company_size_range || c.size_range || '',
    revenue: rec.company_revenue ?? c.revenue ?? null,   // in MILLIONS
    revenue_range: rec.company_revenue_range || c.revenue_range || '',
    city: loc.city || locCity || '',
    state: loc.state || locState || '',
    postal: loc.postal_code || '',
    linkedin: rec.linkedin_url || c.linkedin_url || '',
    naics: rec.naics_code || (c.naics_codes || [])[0] || '',
    specialties: rec.specialties || [],
    logo: rec.logo_url || '',
    id: rec.company_id || c.id || null,
  };
}

export default async function handler(req, res) {
  if (!process.env.SALESINTEL_API_KEY) {
    return res.status(500).json({ error: 'SALESINTEL_API_KEY not set' });
  }

  try {
    // ---------------- single-company enrichment ----------------
    if (req.query.domain) {
      const domain = String(req.query.domain).toLowerCase().trim();
      const cached = await readCache(domain);
      if (cached && !cached.stale) {
        return res.json({ source: 'cache', company: cached.payload });
      }
      try {
        const data = await callSalesIntel({
          company_domain: domain, page_size: 1, verified: 'true',
        });
        const hit = (data.search_results || [])[0];
        if (!hit) return res.json({ source: 'live', company: null });
        const company = normalize(hit);
        await writeCache(domain, company);
        return res.json({ source: 'live', company });
      } catch (e) {
        // Rate-limited or down: serve stale rather than showing an error.
        if (cached) return res.json({ source: 'cache-stale', company: cached.payload });
        throw e;
      }
    }

     // ---------------- discovery: companies we have no record of ----------------
    if (req.query.discover) {
      const limit = Math.min(Number(req.query.limit) || 8, MAX_PAGE);
 
      const params = {
        // page_size is capped at 50 by the API. Over-fetch a little because the
        // filter below drops anything already in company_domains — but only a
        // little, because every record returned costs a credit whether we show
        // it or not.
        page_size: String(Math.min(limit * 3, 50)),
        page: '1',
        verified: 'true',          // human-verified tier; omitting it returns duplicates
        is_international: 'false', // US only; omitting it duplicates per country
      };
 
      if (req.query.state) params.company_location_states = req.query.state;  // ISO abbrev: TX
      if (req.query.naics) params.company_naics_codes = req.query.naics;      // was naics_codes
      if (req.query.sic)   params.company_sic_codes = req.query.sic;
      if (req.query.name)  params.company_name = req.query.name;
      if (req.query.keywords) params.specialties = req.query.keywords;
 
      // Metro targeting: central ZIP + radius in miles. The client sends both.
      if (req.query.zip) {
        params.company_location_zipcodes = req.query.zip;
        params.company_location_zipcodes_distance = String(Number(req.query.radius) || 25);
      }
 
      if (req.query.employees_min) params.company_min_size = String(req.query.employees_min);
      if (req.query.employees_max) params.company_max_size = String(req.query.employees_max);
      // NOTE: revenue is in MILLIONS. 10 means $10M, not $10.
      if (req.query.revenue_min) params.company_min_revenue = String(req.query.revenue_min);
      if (req.query.revenue_max) params.company_max_revenue = String(req.query.revenue_max);
 
      const data = await callSalesIntel(params);
       // TEMPORARY — ?raw=1 returns SalesIntel's untouched response so we can
        // see the real keys and any message. Delete once the shape is confirmed.
      if (req.query.raw) {
        return res.json({ searched: params, raw: data });
      }
      const found = (data.search_results || []).map(normalize).filter(c => c.domain);
 
      // drop anything already in our own records
      const domains = [...new Set(found.map(c => c.domain))];
      let known = new Set();
      if (domains.length) {
        const rows = await sb(
          `company_domains?domain=in.(${domains.map(encodeURIComponent).join(',')})&select=domain`
        );
        known = new Set((rows || []).map(r => r.domain));
      }
 
      const fresh = found.filter(c => !known.has(c.domain)).slice(0, limit);
      for (const c of fresh) await writeCache(c.domain, c);
 
      return res.json({
        source: 'live',
        returned: fresh.length,
        charged: found.length,     // credits burned = records SalesIntel returned
        filtered_out: found.length - fresh.length,
        searched: params,          // what we actually asked for — compare against intent
        companies: fresh,
      });
    }
      return res.status(400).json({ error: 'pass ?domain= or ?discover=1' });
  } catch (e) {
    if (e.code === 429) {
      return res.status(429).json({
        error: 'SalesIntel rate limit reached — try again shortly.',
      });
    }
    return res.status(502).json({ error: String(e.message || e) });
  }
}