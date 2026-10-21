// api/board-series.js — the Sponsors screen's data, in one call.
//
//   GET /api/board-series?series=REDnews%20DFW%20Industrial%20Real%20Estate%20Summit
//   GET /api/board-series                      -> list the available series
//
// Reads v_event_board. Nothing is computed here; the view is the contract,
// so the same numbers come back whether they're read from the app, the SQL
// editor, or a script.
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
  try {
    const series = (req.query.series || '').trim();

    // no series named -> what's available, best first
    if (!series) {
      const rows = await sb(
        'v_event_board?select=series,years_sponsored,emails&limit=20000'
      );
      const byS = new Map();
      for (const r of rows) {
        const s = byS.get(r.series) || { series: r.series, companies: 0, sponsors: 0, emailed: 0 };
        s.companies += 1;
        if (r.years_sponsored > 0) s.sponsors += 1;
        if (r.emails > 0) s.emailed += 1;
        byS.set(r.series, s);
      }
      return res.json({
        series: [...byS.values()].sort((a, b) => b.sponsors - a.sponsors),
      });
    }

    const rows = await sb(
      `v_event_board?series=eq.${encodeURIComponent(series)}` +
      '&select=*&order=emails.desc.nullslast&limit=500'
    );

    // The three groups the screen shows, from one pass.
    const sponsored = rows.filter(r => r.years_sponsored > 0);
    const gap = rows
      .filter(r => r.buys_elsewhere_never_here)
      .sort((a, b) => (b.sponsorships_total - a.sponsorships_total)
                   || (b.emails - a.emails));
    const engaged = rows
      .filter(r => !r.years_sponsored && !r.buys_elsewhere_never_here
                   && (r.years_attended >= 2 || r.spoke > 0))
      .sort((a, b) => (b.emails || 0) - (a.emails || 0));

    // The line worth leading with.
    const headline = gap.length ? {
      companies: gap.length,
      sponsorships_elsewhere: gap.reduce((n, r) => n + (r.sponsorships_total || 0), 0),
      emails_sent: gap.reduce((n, r) => n + (r.emails || 0), 0),
      names: gap.slice(0, 5).map(r => r.company),
    } : null;

    const years = [...new Set(
      rows.flatMap(r => r.sponsor_years || [])
    )].sort();

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
