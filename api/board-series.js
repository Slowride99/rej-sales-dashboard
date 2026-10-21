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

    // NOT using the mv's buys_elsewhere_never_here flag here, deliberately.
    //
    // That flag is `years_sponsored = 0 AND sponsorships_total > 0 AND emails > 0`,
    // which welds together two unrelated questions: did they buy elsewhere and
    // never here (a PheedLoop fact), and have we emailed them (a fact from
    // Jeff's archive). A company whose domain the email index never matched can
    // therefore never be flagged, however much it has bought — which quietly
    // dropped CoStar (9 sponsorships across 5 markets) and Cushman & Wakefield
    // (6 across 4) out of the list entirely.
    //
    // With most companies in a series still unmatched, that exclusion is large
    // and invisible. So the group is the business fact alone, and the email
    // claim in the headline is scoped to the subset we can actually stand
    // behind. Leave the flag in the view — it is still what the index on
    // mv_event_board covers.
    const isGap = r => r.years_sponsored === 0 && (r.sponsorships_total || 0) > 0;

    const gap = rows
      .filter(isGap)
      .sort((a, b) => (b.sponsorships_total - a.sponsorships_total)
                   || ((b.emails || 0) - (a.emails || 0)));

    const engaged = rows
      .filter(r => !r.years_sponsored && !isGap(r)
                   && (r.years_attended >= 2 || r.spoke > 0))
      .sort((a, b) => (b.emails || 0) - (a.emails || 0));

    // the line worth leading with.
    //
    // emailed_companies is the count the email figure actually covers. Saying
    // "24 companies, 639 emails" would imply we emailed all 24; we emailed 20
    // of them and don't know about the rest.
    const emailedGap = gap.filter(r => (r.emails || 0) > 0);

    const headline = gap.length ? {
      companies: gap.length,
      sponsorships_elsewhere: gap.reduce((n, r) => n + (r.sponsorships_total || 0), 0),
      emailed_companies: emailedGap.length,
      emails_sent: emailedGap.reduce((n, r) => n + (r.emails || 0), 0),
      names: gap.slice(0, 5).map(r => r.company),
    } : null;

    // Outreach totals over EVERY company in the series, not just the three
    // groups above — those cover about half the rows, so summing them on the
    // client understated the email volume by roughly the same margin.
    //
    // emails === null means the email index couldn't match the company's
    // domain. That is "not known", so it is counted as unmatched and kept out
    // of every other figure rather than treated as a zero.
    const totals = rows.reduce((t, r) => {
      const e = r.emails == null ? null : Number(r.emails);
      if (e == null) { t.unmatched++; return t; }
      if (e > 0) { t.emails += e; t.companies_emailed++; }
      if (r.ever_replied === true) t.replied++;
      if (r.last_emailed && (!t.last_emailed || r.last_emailed > t.last_emailed)) {
        t.last_emailed = r.last_emailed;
      }
      return t;
    }, { emails: 0, companies_emailed: 0, replied: 0, unmatched: 0, last_emailed: null });

    const years = [...new Set(rows.flatMap(r => r.sponsor_years || []))].sort();

    res.json({
      series,
      years,
      headline,
      totals,
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
