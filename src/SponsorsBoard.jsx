// SponsorsBoard.jsx — the Sponsors screen.
//
// Reads /api/board-series (picker + one series' board), /api/notes (Jeff types
// here, it persists), /api/salesintel (enrichment on demand).
//
// Field names below are taken verbatim from the live /api/board-series
// response, so nothing here is guessed:
//
//   series, years[], counts{companies,sponsored,gap,engaged}
//   headline{companies,sponsorships_elsewhere,emails_sent,names[]}
//   totals{emails,companies_emailed,replied,unmatched,last_emailed}   <- added, see api/board-series.js
//   sponsored[] / gap[] / engaged[] rows:
//     key, company, market, sponsor_years[]|null, years_sponsored,
//     last_sponsored_here|null, attendees, years_attended, spoke,
//     first_seen, last_seen, sponsorships_total, markets_sponsored,
//     last_sponsored_anywhere|null, emails|null, emails_sent|null,
//     last_emailed|null, ever_replied(true|null), domains|null,
//     buys_elsewhere_never_here
//
// Two shapes in the data that will bite if you forget them:
//   * ever_replied is true-or-null, never false
//   * emails/domains are null when the email index couldn't match the company.
//     Null means NOT KNOWN. Never render it as 0 — that would claim we never
//     emailed someone we may well have emailed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './sponsors-board.css';

const DEFAULT_SERIES = 'REDnews DFW Industrial Real Estate Summit';
const COLLAPSED = 12;   // rows shown before "show all"

/* ---------------------------------------------------------------- helpers */

const n = (v) => (v == null ? null : Number(v));
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));

function shortDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y) return null;
  return `${Number(m)}/${Number(d)}/${String(y).slice(2)}`;
}

const cleanName = (s) => String(s || '').replace(/\s{2,}/g, ' ').trim();
const firstDomain = (d) => (d ? String(d).split(',')[0].trim() : null);

async function getJSON(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

/* ------------------------------------------------------------ notes hook */
//
//   GET  /api/notes?series=<name>       -> { notes: { [key]: {body, updated_at} } }
//   POST /api/notes {series,key,body}   -> { ok:true, updated_at }

function useNotes(series) {
  const [notes, setNotes] = useState({});
  const [saving, setSaving] = useState({});
  const timers = useRef({});

  useEffect(() => {
    if (!series) return;
    let alive = true;
    getJSON(`/api/notes?series=${encodeURIComponent(series)}`)
      .then((d) => { if (alive) setNotes(d.notes || {}); })
      .catch(() => { if (alive) setNotes({}); });
    return () => { alive = false; };
  }, [series]);

  const flush = useCallback(async (key, body) => {
    setSaving((s) => ({ ...s, [key]: 'saving' }));
    try {
      const d = await getJSON('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series, key, body }),
      });
      setNotes((prev) => ({ ...prev, [key]: { body, updated_at: d.updated_at } }));
      setSaving((s) => ({ ...s, [key]: 'saved' }));
      setTimeout(() => setSaving((s) => {
        const { [key]: _gone, ...rest } = s; return rest;
      }), 1800);
    } catch {
      setSaving((s) => ({ ...s, [key]: 'error' }));
    }
  }, [series]);

  // type freely; save 800ms after the last keystroke, and again on blur
  const onChange = useCallback((key, body) => {
    setNotes((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), body } }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => flush(key, body), 800);
  }, [flush]);

  const onBlur = useCallback((key, body) => {
    clearTimeout(timers.current[key]);
    flush(key, body);
  }, [flush]);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  return { notes, saving, onChange, onBlur };
}

/* ------------------------------------------------------- sponsors by year */

function SponsorsByYear({ years, sponsored }) {
  const data = useMemo(() => years.map((y) => ({
    year: y,
    names: sponsored
      .filter((r) => (r.sponsor_years || []).includes(y))
      .map((r) => cleanName(r.company)),
  })), [years, sponsored]);

  const max = Math.max(1, ...data.map((d) => d.names.length));

  const retention = useMemo(() => {
    const out = [];
    for (let i = 1; i < data.length; i++) {
      const prev = new Set(data[i - 1].names);
      out.push({
        year: data[i].year,
        back: data[i].names.filter((x) => prev.has(x)).length,
        of: data[i].names.length,
      });
    }
    return out;
  }, [data]);

  const last = retention[retention.length - 1];

  return (
    <section className="card">
      <header className="card-h">
        <h3>Sponsors by year</h3>
        <span className="card-sub">{sponsored.length} companies have sponsored</span>
      </header>

      <div className="hbars" role="img"
           aria-label={data.map((d) => `${d.year}: ${d.names.length}`).join(', ')}>
        {data.map((d) => (
          <div className="hbar" key={d.year}>
            <span className="hbar-lab">{d.year}</span>
            <div className="hbar-track">
              <div
                className="hbar-fill"
                style={{ width: `${(d.names.length / max) * 100}%` }}
                title={d.names.length
                  ? `${d.year} — ${d.names.length} sponsors\n${d.names.join('\n')}`
                  : `${d.year} — none recorded`}
              />
              <span className="hbar-val">{d.names.length}</span>
            </div>
          </div>
        ))}
      </div>

      {last && (
        <p className="card-foot">
          {last.back} of the {last.of} sponsors in {last.year} also sponsored in{' '}
          {last.year - 1}.
        </p>
      )}

      <table className="a11y-table">
        <caption>Sponsors by year</caption>
        <thead><tr><th>Year</th><th>Sponsors</th></tr></thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.year}><td>{d.year}</td><td>{d.names.length}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* -------------------------------------------------------- outreach summary */

function OutreachSummary({ totals, rows }) {
  // Prefer server-side totals (computed over every company in the series).
  // Fall back to the rows on screen if the API hasn't been updated yet — and
  // say so, rather than quietly showing a smaller number as if it were the total.
  const partial = !totals;

  const s = useMemo(() => {
    if (totals) return totals;
    let emails = 0, companies_emailed = 0, replied = 0, unmatched = 0, last_emailed = null;
    for (const r of rows) {
      const e = n(r.emails);
      if (e == null) { unmatched++; continue; }
      if (e > 0) { emails += e; companies_emailed++; }
      if (r.ever_replied === true) replied++;
      if (r.last_emailed && (!last_emailed || r.last_emailed > last_emailed)) {
        last_emailed = r.last_emailed;
      }
    }
    return { emails, companies_emailed, replied, unmatched, last_emailed };
  }, [totals, rows]);

  return (
    <section className="card">
      <header className="card-h">
        <h3>Outreach</h3>
        <span className="card-sub">
          {partial ? 'listed companies only' : "from Jeff's 3-year archive"}
        </span>
      </header>

      <div className="stats">
        <div className="stat">
          <span className="stat-n">{num(s.emails)}</span>
          <span className="stat-l">emails sent</span>
        </div>
        <div className="stat">
          <span className="stat-n">{num(s.companies_emailed)}</span>
          <span className="stat-l">companies reached</span>
        </div>
        <div className="stat">
          <span className="stat-n paid-ink">{num(s.replied)}</span>
          <span className="stat-l">ever replied</span>
        </div>
        <div className="stat">
          <span className="stat-n">{shortDate(s.last_emailed) || '—'}</span>
          <span className="stat-l">last send</span>
        </div>
      </div>

      <p className="card-foot">
        {num(s.unmatched)} companies have no email match yet — their domain isn't in
        the index, so a blank here means unknown, not zero.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------- company row */

function CompanyRow({ r, variant, note, saveState, onNote, onNoteBlur, onEnrich, intel }) {
  const emails = n(r.emails);
  const domain = firstDomain(r.domains);
  const body = note?.body ?? '';

  return (
    <li className="crow">
      <div className="crow-top">
        <span className="crow-name">{cleanName(r.company)}</span>
        {variant === 'gap' && (
          <span className="pill lapsed">
            {r.sponsorships_total} elsewhere · {r.markets_sponsored} market
            {r.markets_sponsored === 1 ? '' : 's'}
          </span>
        )}
        {variant === 'signed' && !!(r.sponsor_years || []).length && (
          <span className="pill paid">{r.sponsor_years.join(', ')}</span>
        )}
      </div>

      <div className="crow-facts">
        {variant === 'gap' && <span className="fact-warn">never sponsored this event</span>}
        {r.attendees > 0 && (
          <span>{r.attendees} attendee{r.attendees === 1 ? '' : 's'} / {r.years_attended} yr</span>
        )}
        {r.spoke > 0 && <span>spoke {r.spoke}×</span>}
        {emails != null && emails > 0 && <span>{num(emails)} emails</span>}
        {r.last_emailed && <span>last {shortDate(r.last_emailed)}</span>}
        {r.ever_replied === true && <span className="fact-ok">replied</span>}
        {emails == null && <span className="fact-dim">no email match</span>}
      </div>

      <div className="crow-tools">
        <textarea
          className={body ? 'has-note' : ''}
          placeholder="Note"
          value={body}
          onChange={(e) => onNote(r.key, e.target.value)}
          onBlur={(e) => onNoteBlur(r.key, e.target.value)}
        />
        {saveState && (
          <span className={`save save-${saveState}`}>
            {saveState === 'saving' ? 'saving…'
              : saveState === 'saved' ? 'saved'
              : "didn't save"}
          </span>
        )}
        {domain && (
          <button type="button" className="btn-mini"
                  title={`SalesIntel — ${domain}`}
                  onClick={() => onEnrich(r.key, domain)}
                  disabled={intel?.state === 'loading'}>
            {intel?.state === 'loading' ? '…' : 'SalesIntel'}
          </button>
        )}
      </div>

      {intel?.state === 'done' && <IntelFacts data={intel.data} />}
      {intel?.state === 'error' && (
        <div className="intel-facts"><span className="fact-dim">{intel.message}</span></div>
      )}
    </li>
  );
}

function IntelFacts({ data }) {
  const c = (Array.isArray(data?.companies) ? data.companies[0] : data?.company) || data || {};
  const pick = (...keys) => {
    for (const k of keys) if (c[k] != null && c[k] !== '') return c[k];
    return null;
  };
  const facts = [
    ['employees', pick('employee_count', 'employees', 'company_size')],
    ['revenue', pick('annual_revenue', 'revenue', 'company_revenue')],
    ['industry', pick('industry', 'company_industry', 'naics_description')],
    ['location', pick('company_location', 'city', 'company_city')],
  ].filter(([, v]) => v != null);

  return (
    <div className="intel-facts">
      {facts.length
        ? facts.map(([k, v]) => <span key={k}><b>{k}</b> {String(v)}</span>)
        : <span className="fact-dim">no record returned</span>}
      {data?.stale && <span className="fact-dim">cached</span>}
    </div>
  );
}

/* ------------------------------------------------------------- row list */

function RowList({ title, sub, rows, variant, hero, rowProps, grid }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, COLLAPSED);

  return (
    <section className={`card${hero ? ' card-hero' : ''}`}>
      <header className="card-h">
        <h3>{title}</h3>
        <span className="card-sub">{sub}</span>
      </header>

      <ul className={grid ? 'crows crows-grid' : 'crows'}>
        {shown.map((r) => <CompanyRow key={r.key} {...rowProps(r, variant)} />)}
      </ul>

      {rows.length > COLLAPSED && (
        <button type="button" className="more" onClick={() => setOpen((v) => !v)}>
          {open ? 'show fewer' : `show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- the screen */

export default function SponsorsBoard() {
  const [picker, setPicker] = useState([]);
  const [series, setSeries] = useState(DEFAULT_SERIES);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);
  const [intel, setIntel] = useState({});

  const { notes, saving, onChange, onBlur } = useNotes(series);

  useEffect(() => {
    getJSON('/api/board-series')
      .then((d) => setPicker(d.series || []))
      .catch(() => setPicker([]));
  }, []);

  useEffect(() => {
    if (!series) return;
    let alive = true;
    setBusy(true); setErr(null);
    getJSON(`/api/board-series?series=${encodeURIComponent(series)}`)
      .then((d) => { if (alive) { setBoard(d); setBusy(false); } })
      .catch((e) => { if (alive) { setErr(e.message); setBusy(false); } });
    return () => { alive = false; };
  }, [series]);

  const enrich = useCallback(async (key, domain) => {
    setIntel((s) => ({ ...s, [key]: { state: 'loading' } }));
    try {
      const d = await getJSON(`/api/salesintel?domain=${encodeURIComponent(domain)}`);
      setIntel((s) => ({ ...s, [key]: { state: 'done', data: d } }));
    } catch (e) {
      setIntel((s) => ({ ...s, [key]: { state: 'error', message: e.message } }));
    }
  }, []);

  const allRows = useMemo(
    () => (board ? [...board.sponsored, ...board.gap, ...board.engaged] : []),
    [board]
  );

  const rowProps = useCallback((r, variant) => ({
    r, variant,
    note: notes[r.key],
    saveState: saving[r.key],
    onNote: onChange,
    onNoteBlur: onBlur,
    onEnrich: enrich,
    intel: intel[r.key],
  }), [notes, saving, onChange, onBlur, enrich, intel]);

  const signed = useMemo(
    () => (board ? [...board.sponsored].sort(
      (a, b) => (b.years_sponsored - a.years_sponsored) || ((b.emails || 0) - (a.emails || 0))
    ) : []),
    [board]
  );

  return (
    <div className="sb" data-theme="dark">
      <header className="sb-top">
        <div className="sb-title">
          <select value={series} onChange={(e) => setSeries(e.target.value)}>
            {picker.length === 0 && <option value={series}>{series}</option>}
            {picker.map((p) => (
              <option key={p.series} value={p.series}>
                {p.series} — {p.sponsors} sponsors, {p.gap} gap
              </option>
            ))}
          </select>
          {board && (
            <span className="sb-years">
              {board.years[0]}–{board.years[board.years.length - 1]} ·{' '}
              {board.counts.companies} companies
            </span>
          )}
        </div>
      </header>

      {busy && <p className="sb-msg">Loading…</p>}
      {err && <p className="sb-msg sb-err">{err}</p>}

      {board && !busy && (
        <>
          {board.headline && (
            <section className="headline">
              <p className="headline-lede">
                <b>{board.headline.companies} companies</b> have bought{' '}
                <b>{num(board.headline.sponsorships_elsewhere)} sponsorships</b> from us
                in other markets and have <b>never sponsored this event</b>. We've sent
                them <b>{num(board.headline.emails_sent)} emails</b>.
              </p>
              <p className="headline-names">
                {board.headline.names.map(cleanName).join(' · ')}
                {board.headline.companies > board.headline.names.length &&
                  ` · +${board.headline.companies - board.headline.names.length} more`}
              </p>
            </section>
          )}

          <div className="band">
            <SponsorsByYear years={board.years} sponsored={board.sponsored} />
            <OutreachSummary totals={board.totals} rows={allRows} />
          </div>

          <RowList
            hero grid
            title="Worth a call"
            sub={`${board.counts.gap} companies`}
            rows={board.gap}
            variant="gap"
            rowProps={rowProps}
          />

          <div className="lists">
            <RowList
              title="Signed"
              sub={`${board.counts.sponsored} companies`}
              rows={signed}
              variant="signed"
              rowProps={rowProps}
            />
            <RowList
              title="In the room, never bought"
              sub={`${board.counts.engaged} companies`}
              rows={board.engaged}
              variant="engaged"
              rowProps={rowProps}
            />
          </div>
        </>
      )}
    </div>
  );
}
