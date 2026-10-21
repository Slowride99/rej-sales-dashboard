// api/board-series.js — the Sponsors screen's data, in one call.
//
//   GET /api/board-series                      -> the series picker
//   GET /api/board-series?series=<name>        -> one series' board
//
// Reads mv_event_board / mv_event_series_summary. Both are materialised,
// so this is an indexed lookup rather than a recompute. After reloading
// company_domains or editing event_series:
//
//   refresh materialized view concurrently public.mv_event_board;
//   refresh materialized view concurrently public.mv_event_series_summary;
//
// Env (server-side only):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async function handler(req, res) {
  if (!SB || !SB_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  try {
    const series = (req.query.series || '').trim();

    // ---- no series named: the picker, straight off the summary ----
    if (!series) {
      const rows = await sb(
        'mv_event_series_summary?select=*&order=gap.desc,sponsors.desc&limit=100'
      );
      return res.json({ count: rows.length, series: rows });
    }

    // ---- one series ----
    const rows = await sb(
      `mv_event_board?series=eq.${encodeURIComponent(series)}` +
      '&select=*&order=emails.desc.nullslast&limit=500'
    );

    if (!rows.length) {
      return res.status(404).json({
        error: `no rows for series "${series}" — check the name against /api/board-series`,
      });
    }

    // the three groups the screen shows
    const sponsored = rows.filter(r => r.years_sponsored > 0);

    const gap = rows
      .filter(r => r.buys_elsewhere_never_here)
      .sort((a, b) => (b.sponsorships_total - a.sponsorships_total)
                   || ((b.emails || 0) - (a.emails || 0)));

    const engaged = rows
      .filter(r => !r.years_sponsored && !r.buys_elsewhere_never_here
                   && (r.years_attended >= 2 || r.spoke > 0))
      .sort((a, b) => (b.emails || 0) - (a.emails || 0));

    // the line worth leading with
    const headline = gap.length ? {
      companies: gap.length,
      sponsorships_elsewhere: gap.reduce((n, r) => n + (r.sponsorships_total || 0), 0),
      emails_sent: gap.reduce((n, r) => n + (r.emails || 0), 0),
      names: gap.slice(0, 5).map(r => r.company),
    } : null;

    const years = [...new Set(rows.flatMap(r => r.sponsor_years || []))].sort();

    res.json({
      series,
      years,
      headline,
      counts: {
        companies: rows.length,
        sponsored: sponsored.length,
        gap: gap.length,
        engaged: engaged.length,
      },
      sponsored,
      gap,
      engaged,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
