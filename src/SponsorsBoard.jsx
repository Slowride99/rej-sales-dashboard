// SponsorsBoard.jsx — the Sponsors screen, in Todd's Layout D structure.
//
//   sidebar  |  event header + picker
//            |  search + chips
//            |  sponsors-by-year grid   (company × year dots, status pill)
//            |  Worth a call | Signed | This event | SalesIntel
//
// Data:
//   /api/board-series                 picker + one series' board
//   /api/board-series?series=<name>   the board
//   /api/board-notes                  Jeff types, it persists
//   /api/salesintel?discover=1        companies we have NO record of
//   /api/salesintel?domain=           enrichment for one company we do know
//
// Field names are verbatim from the live API. Two shapes that bite:
//   * ever_replied is true-or-null, never false
//   * emails/domains are null when the index couldn't match the domain.
//     Null means NOT KNOWN — never render it as 0.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './sponsors-board.css';

const DEFAULT_SERIES = 'REDnews DFW Industrial Real Estate Summit';

const NAV = ['Dashboard', 'Sponsors', 'Speakers', 'Outreach', 'Companies', 'Reports'];

const CHIPS = [
  { id: 'gap',       label: 'bought elsewhere, never here' },
  { id: 'lapsed',    label: 'lapsed since 2023' },
  { id: 'nomail',    label: "who we haven't emailed" },
  { id: 'replied',   label: 'who answered us' },
  { id: 'biggest',   label: 'biggest spenders' },
];

/* ---------------------------------------------------------------- helpers */

const n = (v) => (v == null ? null : Number(v));
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const cleanName = (s) => String(s || '').replace(/\s{2,}/g, ' ').trim();
const firstDomain = (d) => (d ? String(d).split(',')[0].trim() : null);

function shortDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return y ? `${Number(m)}/${Number(d)}/${String(y).slice(2)}` : null;
}

function monogram(name) {
  const w = String(name || '?')
    .replace(/[^A-Za-z0-9 &/-]/g, '')
    .split(/[\s&/-]+/).filter(Boolean);
  if (!w.length) return '?';
  // One word keeps its letters (CBRE, Colliers -> CBRE, COLL); two or more
  // take initials. Taking only the first letter would render CBRE as "C".
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

/* ------------------------------------------------ sponsors-by-year grid */

function YearGrid({ years, sponsored, showElsewhere, onToggle }) {
  const maxY = Math.max(...years);

  const rows = useMemo(() => sponsored
    .map((r) => {
      const ys = r.sponsor_years || [];
      const here = ys.includes(maxY);
      return {
        ...r,
        ys,
        signed: here,
        lapsedBy: here ? 0 : maxY - (r.last_sponsored_here || maxY),
      };
    })
    .sort((a, b) => (b.signed - a.signed)
                 || ((b.last_sponsored_here || 0) - (a.last_sponsored_here || 0))
                 || (b.sponsorships_total - a.sponsorships_total)),
    [sponsored, maxY]);

  const signedCount = rows.filter((r) => r.signed).length;

  return (
    <section className="panel">
      <header className="panel-h">
        <div>
          <h2 className="panel-t">Sponsors by year</h2>
          <p className="panel-s">Every company that has sponsored this event since {years[0]}.</p>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={showElsewhere} onChange={onToggle} />
          <span className="toggle-track"><span className="toggle-knob" /></span>
          <span className="toggle-lab">Also show what they buy elsewhere</span>
        </label>
      </header>

      <div className={`grid-head${showElsewhere ? ' g-else' : ''}`}
           style={{ '--yc': years.length }}>
        <span>Company</span>
        {years.map((y) => (
          <span key={y} className={`gh-y${y === maxY ? ' gh-now' : ''}`}>{y}</span>
        ))}
        {showElsewhere && <span className="gh-y">elsewhere</span>}
        <span className="gh-st">Status</span>
      </div>

      <ul className="grid-rows">
        {rows.map((r) => (
          <li key={r.key} className={`grow${showElsewhere ? ' g-else' : ''}`}
              style={{ '--yc': years.length }}>
            <span className="grow-co">
              <span className="mono">{monogram(r.company)}</span>
              <span className="grow-name">{cleanName(r.company)}</span>
            </span>

            {years.map((y) => (
              <span key={y} className="gcell">
                <span
                  className={`dot${r.ys.includes(y) ? (y === maxY ? ' dot-now' : ' dot-on') : ''}`}
                  title={r.ys.includes(y) ? `Sponsored ${y}` : `No sponsorship ${y}`}
                />
              </span>
            ))}

            {showElsewhere && (
              <span className="gcell gcell-else">
                {r.sponsorships_total > r.years_sponsored
                  ? `${r.sponsorships_total - r.years_sponsored} / ${r.markets_sponsored} mkt`
                  : '—'}
              </span>
            )}

            <span className="gcell-st">
              <span className={`pill ${r.signed ? 'paid' : 'lapsed'}`}>
                {r.signed ? 'Signed' : `Lapsed ${r.lapsedBy} yr${r.lapsedBy === 1 ? '' : 's'}`}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <p className="panel-f">
        {rows.length} companies, {years[0]}–{maxY} ·{' '}
        <span className="ok">{signedCount} signed for {maxY}</span> ·{' '}
        <span className="warn">{rows.length - signedCount} have let it lapse</span>
      </p>

      <table className="a11y-table">
        <caption>Sponsors by year</caption>
        <thead>
          <tr><th>Company</th>{years.map((y) => <th key={y}>{y}</th>)}<th>Status</th></tr>
        </thead>
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

function CallCard({ r, note, saveState, onNote, onNoteBlur }) {
  const emails = n(r.emails);
  const bits = [];
  if (r.attendees > 0) bits.push(`${r.attendees} attendee${r.attendees === 1 ? '' : 's'} over ${r.years_attended} yr`);
  if (r.spoke > 0) bits.push(`spoke ${r.spoke}×`);

  return (
    <article className="ccard">
      <div className="ccard-h">
        <span className="mono">{monogram(r.company)}</span>
        <span className="ccard-name">{cleanName(r.company)}</span>
        <span className="ccard-score">{r.sponsorships_total}</span>
      </div>

      <p className="ccard-why">
        Never sponsored here · {r.sponsorships_total} sponsorship
        {r.sponsorships_total === 1 ? '' : 's'} in {r.markets_sponsored} market
        {r.markets_sponsored === 1 ? '' : 's'}
        {bits.length ? ` · ${bits.join(', ')}` : ''}
      </p>

      <p className="ccard-mail">
        {emails == null
          ? <span className="dim">no email match — domain isn't in the index</span>
          : <>
              {num(emails)} emails · last {shortDate(r.last_emailed)}
              {r.ever_replied === true && <span className="ok"> · replied</span>}
            </>}
      </p>

      <div className="ccard-note">
        <textarea
          className={note?.body ? 'has-note' : ''}
          placeholder="Note — who's covering this, what was said, what's next"
          value={note?.body ?? ''}
          onChange={(e) => onNote(r.key, e.target.value)}
          onBlur={(e) => onNoteBlur(r.key, e.target.value)}
        />
        {saveState && (
          <span className={`save save-${saveState}`}>
            {saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : "didn't save"}
          </span>
        )}
      </div>
    </article>
  );
}

/* --------------------------------------------------------- salesintel */

function SalesIntel({ series, market }) {
  const [state, setState] = useState('idle');
  const [found, setFound] = useState([]);
  const [msg, setMsg] = useState(null);

  const discover = async () => {
    setState('loading'); setMsg(null);
    try {
      const d = await getJSON(`/api/salesintel?discover=1&state=${encodeURIComponent(market || 'TX')}`);
      const list = d.companies || d.results || [];
      setFound(list);
      setState('done');
      if (!list.length) setMsg('Nothing came back that we have no record of.');
      else if (d.stale) setMsg('Served from cache.');
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
          Firms in this market that have never touched a REJournals event — not in
          PheedLoop, not in the email index.
        </p>
      </header>

      <div className="col-body">
        {found.map((c, i) => {
          const name = c.company_name || c.name || c.company_domain || `Company ${i + 1}`;
          const facts = [
            c.industry || c.company_industry,
            c.company_location || c.city,
            c.employee_count || c.company_size,
          ].filter(Boolean);
          return (
            <article className="icard" key={c.company_domain || c.id || i}>
              <div className="icard-name">{name}</div>
              {facts.length > 0 && <div className="icard-facts">{facts.join(' · ')}</div>}
              {c.company_domain && <div className="icard-dom">{c.company_domain}</div>}
            </article>
          );
        })}

        <button className="btn-wide" onClick={discover} disabled={state === 'loading'}>
          {state === 'loading' ? 'Searching…'
            : found.length ? 'Find more like these' : 'Find companies we don\'t know'}
        </button>

        {msg && <p className="col-note">{msg}</p>}
        <p className="col-note">
          Uses credits. Only pulls companies we have no record of — anything already
          in the board is filtered out before the call.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ the screen */

export default function SponsorsBoard() {
  const [nav, setNav] = useState('Sponsors');
  const [picker, setPicker] = useState([]);
  const [series, setSeries] = useState(DEFAULT_SERIES);
  const [board, setBoard] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(true);
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState(null);

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

  const maxY = board ? Math.max(...board.years) : null;

  // Chips and the search box filter rows already on screen. No re-query.
  const callList = useMemo(() => {
    if (!board) return [];
    let rows = [...board.gap, ...board.engaged];
    if (chip === 'gap') rows = board.gap;
    if (chip === 'lapsed') {
      rows = board.sponsored.filter((r) => !(r.sponsor_years || []).includes(maxY));
    }
    if (chip === 'nomail') rows = rows.filter((r) => !(r.emails > 0));
    if (chip === 'replied') rows = rows.filter((r) => r.ever_replied === true);
    if (chip === 'biggest') {
      rows = [...rows].sort((a, b) => b.sponsorships_total - a.sponsorships_total);
    }
    const term = q.trim().toLowerCase();
    if (term) rows = rows.filter((r) => cleanName(r.company).toLowerCase().includes(term));
    if (!chip || chip === 'gap') {
      rows = [...rows].sort((a, b) => (b.sponsorships_total - a.sponsorships_total)
                                   || ((b.emails || 0) - (a.emails || 0)));
    }
    return rows;
  }, [board, chip, q, maxY]);

  const signedNow = useMemo(
    () => (board ? board.sponsored.filter((r) => (r.sponsor_years || []).includes(maxY)) : []),
    [board, maxY]
  );

  // The notes Jeff has written, newest first — "This event" in Todd's layout.
  const log = useMemo(() => {
    if (!board) return [];
    const byKey = new Map(
      [...board.sponsored, ...board.gap, ...board.engaged].map((r) => [r.key, r.company])
    );
    return Object.entries(notes)
      .filter(([, v]) => v?.body?.trim())
      .map(([k, v]) => ({ key: k, company: byKey.get(k) || k, ...v }))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }, [notes, board]);

  const market = board?.sponsored?.[0]?.market || 'TX';

  return (
    <div className="shell" data-theme="dark">
      <aside className="side">
        <div className="brand">RE<span>journals</span></div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item}
              className={`navi${nav === item ? ' navi-on' : ''}`}
              onClick={() => setNav(item)}
            >{item}</button>
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
          <select className="picker" value={series} onChange={(e) => setSeries(e.target.value)}>
            {picker.length === 0 && <option value={series}>{series}</option>}
            {picker.map((p) => (
              <option key={p.series} value={p.series}>
                {p.series} — {p.sponsors} sponsors, {p.gap} gap
              </option>
            ))}
          </select>
        </header>

        {nav !== 'Sponsors' ? (
          <div className="empty">
            <p><b>{nav}</b> isn't built yet.</p>
            <p>Sponsors is the one wired to live data. Everything here reads PheedLoop
               plus Jeff's email archive — no mock rows.</p>
          </div>
        ) : (
          <>
            <div className="search">
              <input
                placeholder="Filter by company name…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>

            <div className="chips">
              {CHIPS.map((c) => (
                <button
                  key={c.id}
                  className={`chip${chip === c.id ? ' chip-on' : ''}`}
                  onClick={() => setChip(chip === c.id ? null : c.id)}
                >{c.label}</button>
              ))}
            </div>

            {busy && <p className="msg">Loading…</p>}
            {err && <p className="msg err">{err}</p>}

            {board && !busy && (
              <>
                {board.headline && (
                  <section className="headline">
                    <p>
                      <b>{board.headline.companies} companies</b> have bought{' '}
                      <b>{num(board.headline.sponsorships_elsewhere)} sponsorships</b> from
                      us in other markets and have <b>never sponsored this event</b>.
                      {board.headline.emailed_companies > 0 && (
                        <> We've emailed <b>{board.headline.emailed_companies} of them</b>,{' '}
                          <b>{num(board.headline.emails_sent)} times</b>.</>
                      )}
                    </p>
                    <p className="headline-n">
                      {board.headline.names.map(cleanName).join(' · ')}
                      {board.headline.companies > board.headline.names.length &&
                        ` · +${board.headline.companies - board.headline.names.length} more`}
                    </p>
                  </section>
                )}

                <YearGrid
                  years={board.years}
                  sponsored={board.sponsored}
                  showElsewhere={showElsewhere}
                  onToggle={() => setShowElsewhere((v) => !v)}
                />

                <div className="cols">
                  <section className="col">
                    <header className="col-h">
                      <h2 className="col-t">Worth a call <span className="ct">{callList.length}</span></h2>
                      <p className="col-s">
                        {chip
                          ? CHIPS.find((c) => c.id === chip).label
                          : 'Bought from us elsewhere, or in the room and never bought. Anyone signed for this year is out.'}
                      </p>
                    </header>
                    <div className="col-body">
                      {callList.slice(0, 40).map((r) => (
                        <CallCard
                          key={r.key}
                          r={r}
                          note={notes[r.key]}
                          saveState={saving[r.key]}
                          onNote={onChange}
                          onNoteBlur={onBlur}
                        />
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
                        <article className="scard" key={r.key}>
                          <div className="ccard-h">
                            <span className="mono">{monogram(r.company)}</span>
                            <span className="ccard-name">{cleanName(r.company)}</span>
                          </div>
                          <p className="ccard-why">
                            <span className="pill paid">{r.years_sponsored} yr
                              {r.years_sponsored === 1 ? '' : 's'}</span>
                            {' '}{(r.sponsor_years || []).join(', ')}
                          </p>
                        </article>
                      ))}
                      {signedNow.length === 0 && <p className="col-note">Nothing signed yet.</p>}
                    </div>
                  </section>

                  <section className="col">
                    <header className="col-h">
                      <h2 className="col-t">This event <span className="ct">{log.length}</span></h2>
                      <p className="col-s">Notes written on this board, newest first.</p>
                    </header>
                    <div className="col-body">
                      {log.map((e) => (
                        <article className="ncard" key={e.key}>
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

                  <SalesIntel series={series} market={market} />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
