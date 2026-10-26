// SponsorsBoard.jsx — Sponsors screen, Todd's Layout D.
//
//   sidebar | header + picker + theme
//           | search + chips
//           | [ sponsors by year ] [ this event — notes ]
//           | headline
//           | [ worth a call ] [ signed ] [ salesintel ]
//           | detail panel (slide-over, on any row or card click)
//
// Data:
//   /api/board-series[?series=]   the board
//   /api/board-notes              Jeff types, it persists
//   /api/salesintel?discover=1    companies we have NO record of
//
// Two shapes in the data that bite:
//   * ever_replied is true-or-null, never false
//   * emails/domains are null when the index couldn't match the domain.
//     Null means NOT KNOWN — never render it as 0.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './sponsors-board.css';

const DEFAULT_SERIES = 'REDnews DFW Industrial Real Estate Summit';
const NAV = ['Dashboard', 'Sponsors', 'Speakers', 'Outreach', 'Companies', 'Reports'];

const CHIPS = [
  { id: 'gap',     label: 'buy from us elsewhere' },
  { id: 'lapsed',  label: 'lapsed sponsors' },
  { id: 'nomail',  label: 'no contact history' },
  { id: 'replied', label: 'have answered us' },
  { id: 'biggest', label: 'biggest spenders' },
];

/* ------------------------------------------- free-text -> SalesIntel query */
//
// "brokers in dallas" is not something the SalesIntel API understands, so it is
// parsed here into the parameters it does take, and the result is shown back to
// the user as removable chips. Guessing silently would mean a search that
// quietly ignored half the sentence.

// SalesIntel stores 4-digit NAICS, not 6 — a real record carries
// naics_codes: ["3371","4491"]. Six-digit codes match nothing at all.
const TRADES = [
  { code: '5312', label: 'brokers',                words: ['broker', 'brokerage', 'agent'] },
  { code: '5311', label: 'building owners',        words: ['owner', 'landlord', 'lessor'] },
  { code: '5313', label: 'property / RE services', words: ['property manager', 'property management', 'real estate', 'realty', 'cre'] },
  { code: '2362', label: 'commercial builders',    words: ['construction', 'contractor', 'builder', 'general contractor'] },
  { code: '2372', label: 'land developers',        words: ['land', 'developer', 'development', 'subdivision'] },
  { code: '5413', label: 'architects / engineers', words: ['architect', 'architecture', 'engineer', 'engineering', 'civil'] },
  { code: '5222', label: 'real estate lenders',    words: ['lender', 'lending', 'mortgage', 'debt', 'capital'] },
];

// SalesIntel has NO city filter — it isn't in their API at all. The documented
// way to target a metro is a central ZIP plus a radius in miles, which also
// behaves better here: "Dallas" as a city string misses Irving, Plano and
// Richardson, which are exactly the industrial submarkets that matter.
const METROS = [
  { name: 'Dallas',       zip: '75201', state: 'TX' },
  { name: 'Fort Worth',   zip: '76102', state: 'TX' },
  { name: 'Houston',      zip: '77002', state: 'TX' },
  { name: 'Austin',       zip: '78701', state: 'TX' },
  { name: 'San Antonio',  zip: '78205', state: 'TX' },
  { name: 'Chicago',      zip: '60601', state: 'IL' },
  { name: 'Minneapolis',  zip: '55401', state: 'MN' },
  { name: 'Saint Paul',   zip: '55101', state: 'MN' },
  { name: 'Milwaukee',    zip: '53202', state: 'WI' },
  { name: 'Indianapolis', zip: '46204', state: 'IN' },
  { name: 'Columbus',     zip: '43215', state: 'OH' },
  { name: 'Cleveland',    zip: '44113', state: 'OH' },
  { name: 'Detroit',      zip: '48226', state: 'MI' },
  { name: 'Kansas City',  zip: '64106', state: 'MO' },
  { name: 'Saint Louis',  zip: '63101', state: 'MO' },
  { name: 'Omaha',        zip: '68102', state: 'NE' },
];
const METRO_ALIASES = { 'dfw': 'Dallas', 'ft worth': 'Fort Worth', 'st paul': 'Saint Paul',
                        'st. paul': 'Saint Paul', 'st louis': 'Saint Louis',
                        'st. louis': 'Saint Louis', 'twin cities': 'Minneapolis' };

const STATES = {
  tx: 'TX', texas: 'TX', il: 'IL', illinois: 'IL', mn: 'MN', minnesota: 'MN',
  wi: 'WI', wisconsin: 'WI', in: 'IN', indiana: 'IN', oh: 'OH', ohio: 'OH',
  mi: 'MI', michigan: 'MI', mo: 'MO', missouri: 'MO', ne: 'NE', nebraska: 'NE',
  ks: 'KS', kansas: 'KS',
};

function parseQuery(text, fallbackState) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return { state: fallbackState };
  // A floor on headcount. Without it the list fills with two-person shops and
  // real estate academies, which is what 5312 returns in volume.
  const out = { radius: 25, employees_min: 10 };

  const trade = TRADES.find((t) => t.words.some((w) => s.includes(w)));
  if (trade) { out.naics = trade.code; out.tradeLabel = trade.label; }

  let metroName = null;
  for (const [alias, real] of Object.entries(METRO_ALIASES)) {
    if (s.includes(alias)) { metroName = real; break; }
  }
  if (!metroName) metroName = METROS.find((m) => s.includes(m.name.toLowerCase()))?.name || null;

  const metro = METROS.find((m) => m.name === metroName);
  if (metro) { out.zip = metro.zip; out.metro = metro.name; out.state = metro.state; }

  if (!out.state) {
    for (const [word, code] of Object.entries(STATES)) {
      if (new RegExp(`\\b${word}\\b`).test(s)) { out.state = code; break; }
    }
  }
  if (!out.state) out.state = fallbackState;

  // nothing recognised: send it as a name search rather than dropping it
  if (!trade && !metro) out.name = String(text).trim();

  return out;
}

/* ------------------------------------------- apply a filter from /api/ask-board */
//
// Runs over rows ALREADY fetched from mv_event_board. The model picked the
// filter; every number on screen is still the view's. Nothing here can invent
// a fact — the worst a bad filter does is produce an odd-looking list.

function applyBoardFilter(board, f, maxY) {
  if (!board) return [];
  const src = {
    sponsored: board.sponsored,
    gap: board.gap,
    engaged: board.engaged,
  }[f?.group] || [...board.gap, ...board.engaged, ...board.sponsored];

  if (!f) return src;

  let out = src.filter((r) => {
    const ys = r.sponsor_years || [];
    const emails = r.emails == null ? null : Number(r.emails);

    if (f.never_sponsored_here && r.years_sponsored > 0) return false;
    if (f.lapsed && !(r.years_sponsored > 0 && !ys.includes(maxY))) return false;
    if (f.lapsed_since != null
        && !(r.last_sponsored_here != null && r.last_sponsored_here < f.lapsed_since)) return false;
    if (f.sponsored_in_year != null && !ys.includes(f.sponsored_in_year)) return false;
    if (f.min_sponsorships_elsewhere != null
        && (r.sponsorships_total || 0) < f.min_sponsorships_elsewhere) return false;
    if (f.min_markets != null && (r.markets_sponsored || 0) < f.min_markets) return false;
    if (f.min_attendees != null && (r.attendees || 0) < f.min_attendees) return false;
    if (f.min_years_attended != null && (r.years_attended || 0) < f.min_years_attended) return false;
    if (f.has_spoken && !(r.spoke > 0)) return false;
    // null emails means NOT KNOWN. It counts as "no contact history" but never
    // as a zero we could quote back at anyone.
    if (f.has_contact_history && !(emails > 0)) return false;
    if (f.no_contact_history && emails > 0) return false;
    if (f.replied && r.ever_replied !== true) return false;
    if (f.not_contacted_since
        && !(r.last_emailed == null || r.last_emailed < f.not_contacted_since)) return false;
    return true;
  });

  const by = {
    sponsorships: (a, b) => (b.sponsorships_total || 0) - (a.sponsorships_total || 0),
    markets:      (a, b) => (b.markets_sponsored || 0) - (a.markets_sponsored || 0),
    emails:       (a, b) => (b.emails || 0) - (a.emails || 0),
    attendees:    (a, b) => (b.attendees || 0) - (a.attendees || 0),
    last_emailed: (a, b) => String(b.last_emailed || '').localeCompare(String(a.last_emailed || '')),
    name:         (a, b) => String(a.company).localeCompare(String(b.company)),
  }[f.sort];
  if (by) out = [...out].sort(by);
  if (f.limit) out = out.slice(0, f.limit);
  return out;
}

/* ---------------------------------------------------------------- helpers */

const n = (v) => (v == null ? null : Number(v));
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const cleanName = (s) => String(s || '').replace(/\s{2,}/g, ' ').trim();

function shortDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y ? `${Number(m)}/${Number(d)}/${String(y).slice(2)}` : null;
}

function monogram(name) {
  const w = String(name || '?').replace(/[^A-Za-z0-9 &/-]/g, '').split(/[\s&/-]+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 4).toUpperCase();
  return w.slice(0, 2).map((x) => x[0]).join('').toUpperCase();
}

async function getJSON(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(body.error || `${r.status}`);
  return body;
}

/* ------------------------------------------------------------ notes hook */

function useNotes(series) {
  const [notes, setNotes] = useState({});
  const [saving, setSaving] = useState({});
  const timers = useRef({});

  useEffect(() => {
    if (!series) return;
    let alive = true;
    getJSON(`/api/board-notes?series=${encodeURIComponent(series)}`)
      .then((d) => { if (alive) setNotes(d.notes || {}); })
      .catch(() => { if (alive) setNotes({}); });
    return () => { alive = false; };
  }, [series]);

  const flush = useCallback(async (key, body) => {
    setSaving((s) => ({ ...s, [key]: 'saving' }));
    try {
      const d = await getJSON('/api/board-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series, key, body }),
      });
      setNotes((p) => ({ ...p, [key]: { body, updated_at: d.updated_at } }));
      setSaving((s) => ({ ...s, [key]: 'saved' }));
      setTimeout(() => setSaving((s) => {
        const { [key]: _g, ...rest } = s; return rest;
      }), 1800);
    } catch {
      setSaving((s) => ({ ...s, [key]: 'error' }));
    }
  }, [series]);

  const onChange = useCallback((key, body) => {
    setNotes((p) => ({ ...p, [key]: { ...(p[key] || {}), body } }));
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

/* --------------------------------------------------------- note textarea */

function NoteBox({ k, note, saveState, onNote, onNoteBlur, placeholder }) {
  return (
    <div className="notebox">
      <textarea
        className={note?.body ? 'has-note' : ''}
        placeholder={placeholder || 'Note'}
        value={note?.body ?? ''}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onNote(k, e.target.value)}
        onBlur={(e) => onNoteBlur(k, e.target.value)}
      />
      {saveState && (
        <span className={`save save-${saveState}`}>
          {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : "didn't save"}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------ sponsors-by-year grid */

function YearGrid({ years, sponsored, showElsewhere, onToggle, onPick }) {
  const maxY = Math.max(...years);

  const rows = useMemo(() => sponsored
    .map((r) => {
      const ys = r.sponsor_years || [];
      const here = ys.includes(maxY);
      return { ...r, ys, signed: here, lapsedBy: here ? 0 : maxY - (r.last_sponsored_here || maxY) };
    })
    .sort((a, b) => (b.signed - a.signed)
                 || ((b.last_sponsored_here || 0) - (a.last_sponsored_here || 0))
                 || (b.sponsorships_total - a.sponsorships_total)),
    [sponsored, maxY]);

  const signedCount = rows.filter((r) => r.signed).length;
  const cls = showElsewhere ? ' g-else' : '';

  return (
    <section className="panel">
      <header className="panel-h">
        <div>
          <h2 className="panel-t">Sponsors by year</h2>
          <p className="panel-s">Everyone who has sponsored since {years[0]}. Click a row.</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showElsewhere} onChange={onToggle} />
          <span className="toggle-track"><span className="toggle-knob" /></span>
          <span>Elsewhere</span>
        </label>
      </header>

      <div className={`grid-head${cls}`} style={{ '--yc': years.length }}>
        <span>Company</span>
        {years.map((y) => (
          <span key={y} className={`gh-y${y === maxY ? ' gh-now' : ''}`}>{String(y).slice(2)}</span>
        ))}
        {showElsewhere && <span className="gh-y">elsewhere</span>}
        <span className="gh-st">Status</span>
      </div>

      <ul className="grid-rows">
        {rows.map((r) => (
          <li key={r.key} className={`grow${cls}`} style={{ '--yc': years.length }}>
            <button className="grow-hit" onClick={() => onPick(r)}>
              <span className="grow-co">
                <span className="mono">{monogram(r.company)}</span>
                <span className="grow-name">{cleanName(r.company)}</span>
              </span>
              {years.map((y) => (
                <span key={y} className="gcell">
                  <span className={`dot${r.ys.includes(y) ? (y === maxY ? ' dot-now' : ' dot-on') : ''}`} />
                </span>
              ))}
              {showElsewhere && (
                <span className="gcell gcell-else">
                  {r.sponsorships_total > r.years_sponsored
                    ? `${r.sponsorships_total - r.years_sponsored} / ${r.markets_sponsored}`
                    : '—'}
                </span>
              )}
              <span className="gcell-st">
                <span className={`pill ${r.signed ? 'paid' : 'lapsed'}`}>
                  {r.signed ? 'Signed' : `Lapsed ${r.lapsedBy}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="panel-f">
        {rows.length} companies, {years[0]}–{maxY} ·{' '}
        <span className="ok">{signedCount} signed for {maxY}</span> ·{' '}
        <span className="warn">{rows.length - signedCount} lapsed</span>
      </p>

      <table className="a11y-table">
        <caption>Sponsors by year</caption>
        <thead><tr><th>Company</th>{years.map((y) => <th key={y}>{y}</th>)}<th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{cleanName(r.company)}</td>
              {years.map((y) => <td key={y}>{r.ys.includes(y) ? 'yes' : 'no'}</td>)}
              <td>{r.signed ? 'Signed' : `Lapsed ${r.lapsedBy}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/* ------------------------------------------------------------ call card */

function CallCard({ r, note, saveState, onNote, onNoteBlur, onPick }) {
  const emails = n(r.emails);
  const bits = [];
  if (r.attendees > 0) bits.push(`${r.attendees} attendee${r.attendees === 1 ? '' : 's'} over ${r.years_attended} yr`);
  if (r.spoke > 0) bits.push(`spoke ${r.spoke}×`);

  return (
    <article className="ccard" onClick={() => onPick(r)}>
      <div className="ccard-h">
        <span className="mono">{monogram(r.company)}</span>
        <span className="ccard-name">{cleanName(r.company)}</span>
        {r.sponsorships_total > 0 && <span className="ccard-score">{r.sponsorships_total}</span>}
      </div>

      <p className="ccard-why">
        {r.sponsorships_total > 0
          ? <>Buys from us in {r.markets_sponsored} other market{r.markets_sponsored === 1 ? '' : 's'} · {r.sponsorships_total} sponsorship{r.sponsorships_total === 1 ? '' : 's'}</>
          : <>In the room, hasn't sponsored anywhere yet</>}
        {bits.length ? ` · ${bits.join(', ')}` : ''}
      </p>

      <p className="ccard-mail">
        {emails == null
          ? <span className="dim">no contact history on file</span>
          : <>{num(emails)} emails · last {shortDate(r.last_emailed)}
              {r.ever_replied === true && <span className="ok"> · replied</span>}</>}
      </p>

      <NoteBox k={r.key} note={note} saveState={saveState}
               onNote={onNote} onNoteBlur={onNoteBlur}
               placeholder="Note — who's covering this, what's next" />
    </article>
  );
}

/* ------------------------------------------------------- detail slide-over */

function Detail({ r, years, note, saveState, onNote, onNoteBlur, onClose }) {
  if (!r) return null;
  const maxY = Math.max(...years);
  const ys = r.sponsor_years || [];
  const emails = n(r.emails);

  const Fact = ({ label, children }) => (
    <div className="dfact"><span className="dfact-l">{label}</span><span className="dfact-v">{children}</span></div>
  );

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="detail" onClick={(e) => e.stopPropagation()}>
        <header className="detail-h">
          <span className="mono mono-lg">{monogram(r.company)}</span>
          <div style={{ minWidth: 0 }}>
            <h2 className="detail-t">{cleanName(r.company)}</h2>
            <p className="detail-s">
              {ys.includes(maxY) ? `Sponsoring ${maxY}`
                : ys.length ? `Last sponsored here in ${r.last_sponsored_here}`
                : 'Has never sponsored this event'}
            </p>
          </div>
          <button className="xbtn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="detail-b">
          {r.discovered && (
            <>
              <section>
                <h3 className="dsec">From SalesIntel</h3>
                {r.si.industry && <Fact label="Industry">{r.si.industry}</Fact>}
                {r.si.sector && <Fact label="Sector">{r.si.sector}</Fact>}
                {(r.si.employees_range || r.si.employees) &&
                  <Fact label="Headcount">{r.si.employees_range || r.si.employees}</Fact>}
                {(r.si.revenue_range || r.si.revenue != null) &&
                  <Fact label="Revenue">{r.si.revenue_range
                    || `$${r.si.revenue}M`}</Fact>}
                {(r.si.city || r.si.state) &&
                  <Fact label="Location">{[r.si.city, r.si.state].filter(Boolean).join(', ')}</Fact>}
                {r.si.naics && <Fact label="NAICS">{r.si.naics}</Fact>}
                {!!(r.si.specialties || []).length && (
                  <Fact label="Keywords">{r.si.specialties.slice(0, 8).join(', ')}</Fact>
                )}
              </section>

              <section>
                <h3 className="dsec">Open</h3>
                <div className="dlinks">
                  {r.si.domain && (
                    <a className="btn-wide" target="_blank" rel="noreferrer"
                       href={`https://${r.si.domain}`}>Website</a>
                  )}
                  {r.si.linkedin && (
                    <a className="btn-wide" target="_blank" rel="noreferrer"
                       href={r.si.linkedin.startsWith('http') ? r.si.linkedin
                             : `https://${r.si.linkedin}`}>LinkedIn</a>
                  )}
                </div>
                <p className="dnote" style={{ marginTop: 10 }}>
                  No history with us — this firm appears nowhere in PheedLoop or the
                  contact index. A note here puts it in <b>This event</b> so it can be
                  assigned like any other call.
                </p>
              </section>

              <section>
                <h3 className="dsec">Notes</h3>
                <NoteBox k={r.key} note={note} saveState={saveState}
                         onNote={onNote} onNoteBlur={onNoteBlur}
                         placeholder="Who's calling this one, and why" />
              </section>
            </>
          )}

          {!r.discovered && <>
          <section>
            <h3 className="dsec">This event</h3>
            <div className="dyears">
              {years.map((y) => (
                <span key={y} className={`dyear${ys.includes(y) ? ' dyear-on' : ''}`}>
                  <span className="dyear-n">{y}</span>
                  <span className={`dot${ys.includes(y) ? (y === maxY ? ' dot-now' : ' dot-on') : ''}`} />
                </span>
              ))}
            </div>
            <Fact label="Attendees">{r.attendees || 0} over {r.years_attended || 0} year{r.years_attended === 1 ? '' : 's'}</Fact>
            <Fact label="Speaking slots">{r.spoke || 0}</Fact>
            <Fact label="First / last seen">{r.first_seen} – {r.last_seen}</Fact>
          </section>

          <section>
            <h3 className="dsec">Across REJournals</h3>
            <Fact label="Sponsorships">{r.sponsorships_total || 0}</Fact>
            <Fact label="Markets">{r.markets_sponsored || 0}</Fact>
            <Fact label="Last sponsored anywhere">{r.last_sponsored_anywhere || '—'}</Fact>
          </section>

          <section>
            <h3 className="dsec">Contact history</h3>
            {emails == null ? (
              <p className="dnote">
                No domain match in the email index, so there's nothing on file here.
                That doesn't mean they were never contacted — it means we can't see it.
              </p>
            ) : (
              <>
                <Fact label="Emails">{num(emails)}{r.emails_sent != null && ` (${num(r.emails_sent)} outbound)`}</Fact>
                <Fact label="Last contact">{shortDate(r.last_emailed) || '—'}</Fact>
                <Fact label="Replied">{r.ever_replied === true
                  ? <span className="ok">yes</span>
                  : <span className="dim">none on file</span>}</Fact>
                {r.domains && <Fact label="Domains">{r.domains}</Fact>}
              </>
            )}
          </section>

          <section>
            <h3 className="dsec">Notes</h3>
            <NoteBox k={r.key} note={note} saveState={saveState}
                     onNote={onNote} onNoteBlur={onNoteBlur}
                     placeholder="What was said, what's next, who owns it" />
          </section>
          </>}
        </div>
      </aside>
    </div>
  );
}

/* --------------------------------------------------------------- salesintel */

// A SalesIntel hit dressed as a board row so the same detail panel and the same
// note store can handle it. The `si:` key prefix keeps it from ever colliding
// with a real company key — and because event_notes has no foreign key into
// company_facts, a note against it just works.
function discoveredRow(c) {
  return {
    key: `si:${c.domain}`,
    company: c.name || c.domain,
    discovered: true,
    si: c,
    sponsor_years: null, years_sponsored: 0, attendees: 0, years_attended: 0,
    spoke: 0, sponsorships_total: 0, markets_sponsored: 0,
    emails: null, ever_replied: null, domains: c.domain,
  };
}

function SalesIntel({ market, onPick }) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle');
  const [found, setFound] = useState([]);
  const [used, setUsed] = useState(null);
  const [msg, setMsg] = useState(null);

  const parsed = useMemo(() => parseQuery(text, market), [text, market]);

  const run = async () => {
    setState('loading'); setMsg(null);
    const qs = new URLSearchParams({ discover: '1', limit: '8' });
    if (parsed.state) qs.set('state', parsed.state);
    if (parsed.zip) { qs.set('zip', parsed.zip); qs.set('radius', String(parsed.radius || 25)); }
    if (parsed.naics) qs.set('naics', parsed.naics);
    if (parsed.name) qs.set('name', parsed.name);
    if (parsed.employees_min) qs.set('employees_min', String(parsed.employees_min));
    try {
      const d = await getJSON(`/api/salesintel?${qs}`);
      setFound(d.companies || []);
      setUsed(d.searched || null);
      setState('done');
      if (!d.companies?.length) {
        setMsg(d.filtered_out
          ? `Everything that came back is already in our records (${d.filtered_out} filtered out).`
          : 'Nothing came back for that.');
      } else if (d.filtered_out) {
        setMsg(`${d.filtered_out} already in our records, filtered out.`);
      }
    } catch (e) {
      setState('error'); setMsg(e.message);
    }
  };

  return (
    <section className="col col-intel">
      <header className="col-h">
        <span className="tag">SalesIntel</span>
        <h2 className="col-t">Beyond our records</h2>
        <p className="col-s">
          Firms with no trace anywhere in our data — not in PheedLoop, not in the
          contact index.
        </p>
      </header>

      <div className="col-body">
        <form className="si-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
          <input
            placeholder="brokers in dallas"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn-go" disabled={state === 'loading'}>
            {state === 'loading' ? '…' : 'Search'}
          </button>
        </form>

        {(parsed.tradeLabel || parsed.metro || parsed.state || parsed.name) && (
          <div className="si-chips">
            {parsed.tradeLabel && <span className="sic">{parsed.tradeLabel}</span>}
            {parsed.metro && <span className="sic">{parsed.metro} +{parsed.radius}mi</span>}
            {parsed.state && <span className="sic">{parsed.state}</span>}
            {parsed.name && <span className="sic sic-dim">name: {parsed.name}</span>}
          </div>
        )}

        {found.map((c, i) => (
          <article className="icard icard-hit" key={c.domain || i}
                   onClick={() => onPick(discoveredRow(c))}>
            <div className="icard-name">{c.name || c.domain || 'Unnamed company'}</div>
            <div className="icard-facts">
              {[c.industry,
                [c.city, c.state].filter(Boolean).join(', '),
                c.employees_range ? `${c.employees_range} staff` : (c.employees && `${c.employees} staff`),
               ].filter(Boolean).join(' · ')}
            </div>
            {c.domain && <div className="icard-dom">{c.domain}</div>}
          </article>
        ))}

        {msg && <p className="col-note">{msg}</p>}

        {used && state === 'done' && (
          <p className="col-note dim">
            Searched: {Object.entries(used)
              .filter(([k]) => !['page', 'page_size', 'verified'].includes(k))
              .map(([k, v]) => `${k.replace(/^company_location_|^company_|_codes$/g, '')} ${v}`)
              .join(' · ') || 'no filters'}
          </p>
        )}

        <p className="col-note">
          Uses credits — charged per company returned. Anything already in the
          board is filtered out before you see it.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- the screen */

export default function SponsorsBoard() {
  const [theme, setTheme] = useState('dark');
  const [nav, setNav] = useState('Sponsors');
  const [picker, setPicker] = useState([]);
  const [series, setSeries] = useState(DEFAULT_SERIES);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState(null);
  const [pick, setPick] = useState(null);
  const [discovered, setDiscovered] = useState({});   // si:<domain> -> name
  const [ai, setAi] = useState(null);
  const [asking, setAsking] = useState(false);
  const [askErr, setAskErr] = useState(null);

  const { notes, saving, onChange, onBlur } = useNotes(series);

  useEffect(() => {
    getJSON('/api/board-series').then((d) => setPicker(d.series || [])).catch(() => setPicker([]));
  }, []);

  useEffect(() => {
    if (!series) return;
    let alive = true;
    setBusy(true); setErr(null); setPick(null);
    getJSON(`/api/board-series?series=${encodeURIComponent(series)}`)
      .then((d) => { if (alive) { setBoard(d); setBusy(false); } })
      .catch((e) => { if (alive) { setErr(e.message); setBusy(false); } });
    return () => { alive = false; };
  }, [series]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') setPick(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const maxY = board ? Math.max(...board.years) : null;

  const ask = useCallback(async (e) => {
    e?.preventDefault();
    const question = q.trim();
    if (!question) { setAi(null); setAskErr(null); return; }
    setAsking(true); setAskErr(null);
    try {
      const d = await getJSON('/api/ask-board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (d.unsupported) { setAi(null); setAskErr(d.message); }
      else { setAi(d); setChip(null); }
    } catch (err) {
      setAskErr(err.message);
    } finally {
      setAsking(false);
    }
  }, [q]);

  const clearAsk = useCallback(() => {
    setAi(null); setAskErr(null); setQ('');
  }, []);

  const callList = useMemo(() => {
    if (!board) return [];
    if (ai?.filter) return applyBoardFilter(board, ai.filter, maxY);
    let rows = [...board.gap, ...board.engaged];
    if (chip === 'gap') rows = board.gap;
    if (chip === 'lapsed') rows = board.sponsored.filter((r) => !(r.sponsor_years || []).includes(maxY));
    if (chip === 'nomail') rows = rows.filter((r) => !(r.emails > 0));
    if (chip === 'replied') rows = rows.filter((r) => r.ever_replied === true);
    if (chip === 'biggest') rows = [...rows].sort((a, b) => b.sponsorships_total - a.sponsorships_total);
    const term = q.trim().toLowerCase();
    if (term) rows = rows.filter((r) => cleanName(r.company).toLowerCase().includes(term));
    if (!chip || chip === 'gap') {
      rows = [...rows].sort((a, b) => (b.sponsorships_total - a.sponsorships_total)
                                   || ((b.emails || 0) - (a.emails || 0)));
    }
    return rows;
  }, [board, chip, q, maxY, ai]);

  const signedNow = useMemo(
    () => (board ? board.sponsored.filter((r) => (r.sponsor_years || []).includes(maxY)) : []),
    [board, maxY]
  );

  const byKey = useMemo(() => {
    const m = new Map(
      board ? [...board.sponsored, ...board.gap, ...board.engaged].map((r) => [r.key, r]) : []
    );
    // discovered firms too, so a note against one shows its name in the log
    // rather than a bare si:domain key
    for (const [k, row] of Object.entries(discovered)) m.set(k, row);
    return m;
  }, [board, discovered]);

  const log = useMemo(() => Object.entries(notes)
    .filter(([, v]) => v?.body?.trim())
    .map(([k, v]) => ({ key: k, company: byKey.get(k)?.company || k, ...v }))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    [notes, byKey]);

  const market = board?.sponsored?.[0]?.market || 'TX';

  const noteProps = (k) => ({
    note: notes[k], saveState: saving[k], onNote: onChange, onNoteBlur: onBlur,
  });

  return (
    <div className="shell" data-theme={theme}>
      <aside className="side">
        <div className="brand">RE<span>journals</span></div>
        <nav>
          {NAV.map((item) => (
            <button key={item} className={`navi${nav === item ? ' navi-on' : ''}`}
                    onClick={() => setNav(item)}>{item}</button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="top">
          <div className="top-l">
            <p className="eyebrow">{market === 'TX' ? 'Texas' : market}</p>
            <h1 className="h1">{series}</h1>
            {board && (
              <p className="sub">
                {board.years[0]}–{maxY} · {board.counts.companies} companies ·{' '}
                {board.counts.sponsored} have sponsored
              </p>
            )}
          </div>
          <div className="top-r">
            <select className="picker" value={series} onChange={(e) => setSeries(e.target.value)}>
              {picker.length === 0 && <option value={series}>{series}</option>}
              {picker.map((p) => (
                <option key={p.series} value={p.series}>
                  {p.series} — {p.sponsors} sponsors, {p.gap} gap
                </option>
              ))}
            </select>
            <button className="themebtn"
                    onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </header>

        {nav !== 'Sponsors' ? (
          <div className="empty">
            <p><b>{nav}</b> isn't built yet.</p>
            <p>Sponsors is the one wired to live data — PheedLoop plus the contact
               index. No mock rows anywhere on it.</p>
          </div>
        ) : (
          <>
            <form className="search" onSubmit={ask}>
              <input
                placeholder="Ask for a list — who sponsored in 2023 but hasn't since?"
                value={q}
                onChange={(e) => { setQ(e.target.value); if (ai) setAi(null); }}
              />
              <button className="btn-go" disabled={asking}>
                {asking ? 'Thinking…' : 'Ask'}
              </button>
              {(ai || askErr) && (
                <button type="button" className="themebtn" onClick={clearAsk}>Clear</button>
              )}
            </form>

            {/* Typing filters by name as you go; pressing Ask sends the
                sentence to the model, which returns a filter — never numbers. */}
            {ai && (
              <p className="askedlabel">
                <span className="sic">{ai.label}</span>
                <span className="dim"> · {callList.length} companies</span>
              </p>
            )}
            {askErr && <p className="askedlabel dim">{askErr}</p>}

            <div className="chips">
              {CHIPS.map((c) => (
                <button key={c.id} className={`chip${chip === c.id ? ' chip-on' : ''}`}
                        onClick={() => { setAi(null); setAskErr(null);
                                         setChip(chip === c.id ? null : c.id); }}>{c.label}</button>
              ))}
            </div>

            {busy && <p className="msg">Loading…</p>}
            {err && <p className="msg err">{err}</p>}

            {board && !busy && (
              <>
                <div className="band">
                  <YearGrid
                    years={board.years}
                    sponsored={board.sponsored}
                    showElsewhere={showElsewhere}
                    onToggle={() => setShowElsewhere((v) => !v)}
                    onPick={setPick}
                  />

                  <section className="col">
                    <header className="col-h">
                      <h2 className="col-t">This event <span className="ct">{log.length}</span></h2>
                      <p className="col-s">Notes written on this board, newest first.</p>
                    </header>
                    <div className="col-body">
                      {log.map((e) => (
                        <article className="ncard" key={e.key}
                                 onClick={() => byKey.get(e.key) && setPick(byKey.get(e.key))}>
                          <div className="ncard-h">
                            <span className="ncard-co">{cleanName(e.company)}</span>
                            <span className="ncard-d">{shortDate(e.updated_at)}</span>
                          </div>
                          <p className="ncard-b">{e.body}</p>
                        </article>
                      ))}
                      {log.length === 0 && (
                        <p className="col-note">
                          Nothing yet. Type in any card's note box and it lands here.
                        </p>
                      )}
                    </div>
                  </section>
                </div>

                {board.headline && (
                  <section className="headline">
                    <p>
                      <b>{board.headline.companies} companies</b> already buy from
                      REJournals in other markets — <b>{num(board.headline.sponsorships_elsewhere)} sponsorships</b>
                      {' '}between them — and none have sponsored this event yet.
                    </p>
                    <p className="headline-n">
                      {board.headline.emailed_companies > 0 && (
                        <>{board.headline.emailed_companies} already have contact history,{' '}
                          {board.headline.companies - board.headline.emailed_companies} are cold · </>
                      )}
                      {board.headline.names.map(cleanName).join(' · ')}
                      {board.headline.companies > board.headline.names.length &&
                        ` · +${board.headline.companies - board.headline.names.length} more`}
                    </p>
                  </section>
                )}

                <div className="cols">
                  <section className="col">
                    <header className="col-h">
                      <h2 className="col-t">Worth a call <span className="ct">{callList.length}</span></h2>
                      <p className="col-s">
                        {ai ? `Answering: "${ai.question || q}"`
                            : chip ? CHIPS.find((c) => c.id === chip).label
                            : 'Ranked by what they buy from us elsewhere. Anyone signed for this year is out.'}
                      </p>
                    </header>
                    <div className="col-body">
                      {callList.slice(0, 40).map((r) => (
                        <CallCard key={r.key} r={r} onPick={setPick} {...noteProps(r.key)} />
                      ))}
                      {callList.length === 0 && <p className="col-note">Nothing matches that.</p>}
                    </div>
                  </section>

                  <section className="col">
                    <header className="col-h">
                      <h2 className="col-t">Signed <span className="ct">{signedNow.length}</span></h2>
                      <p className="col-s">Sponsoring {maxY}, from PheedLoop.</p>
                    </header>
                    <div className="col-body">
                      {signedNow.map((r) => (
                        <article className="scard" key={r.key} onClick={() => setPick(r)}>
                          <div className="ccard-h">
                            <span className="mono">{monogram(r.company)}</span>
                            <span className="ccard-name">{cleanName(r.company)}</span>
                          </div>
                          <p className="ccard-why">
                            <span className="pill paid">
                              {r.years_sponsored} yr{r.years_sponsored === 1 ? '' : 's'}
                            </span>{' '}
                            {(r.sponsor_years || []).join(', ')}
                          </p>
                        </article>
                      ))}
                      {signedNow.length === 0 && <p className="col-note">Nothing signed yet.</p>}
                    </div>
                  </section>

                  <SalesIntel
                    market={market}
                    onPick={(row) => {
                      setDiscovered((d) => ({ ...d, [row.key]: row }));
                      setPick(row);
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </main>

      <Detail r={pick} years={board?.years || []} onClose={() => setPick(null)}
              {...(pick ? noteProps(pick.key) : { onNote: () => {}, onNoteBlur: () => {} })} />
    </div>
  );
}
