// AccountsBoard.jsx — advertising accounts, one office at a time.
//
//   sidebar | header + office picker + theme
//           | five tiles: active / lapsed / older / events only / follow-ups due
//           | search + product filters
//           | the list: company · years · bought · last ad · orders · total · stage · follow up
//           | slide-over: work, note, people, purchases, not closed, mail
//
// The sponsors board answers "who should sponsor THIS EVENT". This answers
// "who buys ads from THIS OFFICE, who stopped, and who have I not called".
//
// Data:   /api/accounts            (Zoho sales history, db/zoho_accounts.sql)
// Notes:  /api/board-notes         series 'accounts:<office>', key 'zoho:<id>'
// Mail:   /api/mail?domain=        the same live Outlook index the board uses
//
// Self-contained on purpose: its own stylesheet, its own class prefix (ab-),
// no imports from SponsorsBoard. Nothing here can break the sponsors screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './accounts-board.css';

/* ------------------------------------------------------------------ words */

const STATUS = {
  active:        { label: 'Active',      tile: 'Active advertisers',  hint: 'Bought an ad this year or last' },
  lapsed:        { label: 'Lapsed',      tile: 'Lapsed advertisers',  hint: 'Last ad two to four years ago' },
  older:         { label: 'Older',       tile: 'Older advertisers',   hint: 'Last ad more than four years ago' },
  'events only': { label: 'Events only', tile: 'Event buyers, no ad', hint: 'Sponsor or attend awards, never bought an ad' },
};
const STATUS_ORDER = ['active', 'lapsed', 'older', 'events only'];

// Provisional. These are placeholders until the people doing the selling say
// what their steps are called — the column stores free text, so changing this
// list later loses nothing already saved.
const STAGES = ['To contact', 'Contacted', 'In conversation', 'Proposal sent', 'Sold', 'Not now'];

const KIND = { print: 'Print', email: 'Email', banner: 'Banner', event: 'Event', awards: 'Awards', other: 'Other' };
const BOUGHT = [
  ['bought_print', 'Print'], ['bought_email', 'Email'], ['bought_banner', 'Banner'],
  ['bought_event', 'Event'], ['bought_awards', 'Awards'],
];

/* ---------------------------------------------------------------- helpers */

const money = (n) => (n == null ? '' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
const day = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const monogram = (name) => {
  const w = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
};
const place = (r) => [r.billing_city, r.billing_state].filter(Boolean).join(', ');
const today = () => new Date().toISOString().slice(0, 10);

async function getJSON(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status}`);
  return d;
}

/* ------------------------------------------------------------ small parts */

function StatusPill({ status }) {
  const s = STATUS[status];
  return <span className={`ab-pill ab-pill-${status.replace(' ', '-')}`}>{s ? s.label : status}</span>;
}

// One mark per year. Filled = an ad ran that year. Ring = bought something,
// but not an ad. Dot = nothing. Shape carries it, not colour alone.
function YearStrip({ years, adYears, saleYears }) {
  const ads = new Set(adYears || []);
  const any = new Set(saleYears || []);
  return (
    <span className="ab-years" role="img"
      aria-label={`Ads in ${[...ads].sort().join(', ') || 'no year'}`}>
      {years.map((y) => (
        <i key={y}
          className={ads.has(y) ? 'ab-y ab-y-ad' : any.has(y) ? 'ab-y ab-y-other' : 'ab-y'}
          title={`${y}: ${ads.has(y) ? 'ad' : any.has(y) ? 'event or awards only' : 'nothing'}`} />
      ))}
    </span>
  );
}

function StageSelect({ row, onSave, compact }) {
  return (
    <select className="ab-in" value={row.stage || ''} aria-label={`Stage for ${row.name}`}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onSave(row, { stage: e.target.value })}>
      <option value="">{compact ? '—' : 'No stage yet'}</option>
      {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
      {row.stage && !STAGES.includes(row.stage) && <option value={row.stage}>{row.stage}</option>}
    </select>
  );
}

function FollowUp({ row, onSave }) {
  const due = row.follow_up_on && row.follow_up_on <= today();
  return (
    <input type="date" className={`ab-in${due ? ' ab-in-due' : ''}`}
      value={row.follow_up_on || ''} aria-label={`Follow-up date for ${row.name}`}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onSave(row, { follow_up_on: e.target.value })} />
  );
}

/* ------------------------------------------------------------ slide-over */

function Detail({ row, office, note, onNote, onSave, onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [mail, setMail] = useState(null);
  const [allPeople, setAllPeople] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null); setErr(''); setMail(null); setAllPeople(false);
    getJSON(`/api/accounts?office=${encodeURIComponent(office)}&id=${row.account_id}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e.message); });
    if (row.domain) {
      getJSON(`/api/mail?domain=${encodeURIComponent(row.domain)}&top=8`)
        .then((d) => { if (alive) setMail(d); })
        .catch(() => { if (alive) setMail({ failed: true, messages: [] }); });
    }
    return () => { alive = false; };
  }, [row.account_id, row.domain, office]);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const byYear = useMemo(() => {
    const m = new Map();
    for (const s of data?.sales || []) {
      if (!m.has(s.sale_year)) m.set(s.sale_year, []);
      m.get(s.sale_year).push(s);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [data]);

  const elsewhere = (data?.offices || []).filter((o) => o.office !== office);

  return (
    <div className="ab-scrim" onClick={onClose}>
      <aside className="ab-detail" onClick={(e) => e.stopPropagation()} aria-label={row.name}>
        <header className="ab-d-head">
          <div>
            <h2 className="ab-d-name">{row.name}</h2>
            <p className="ab-d-sub">
              {[place(row), row.domain].filter(Boolean).join(' · ') || 'No address on file'}
            </p>
          </div>
          <button className="ab-x" onClick={onClose} aria-label="Close">Close</button>
        </header>

        <div className="ab-d-facts">
          <StatusPill status={row.status} />
          <span>{row.last_ad_year ? `Last ad ${row.last_ad_year}` : 'No ads yet'}</span>
          <span>{row.orders} {row.orders === 1 ? 'order' : 'orders'} from {office}</span>
          <span>{money(row.total)}</span>
        </div>
        {elsewhere.length > 0 && (
          <p className="ab-d-else">
            Also a customer of {elsewhere.map((o) =>
              `${o.office} (${o.orders} ${o.orders === 1 ? 'order' : 'orders'}, last ${o.last_year})`).join(' and ')}.
          </p>
        )}

        <section className="ab-sec">
          <h3 className="ab-h3">Where it stands</h3>
          <div className="ab-work"><StageSelect row={row} onSave={onSave} /><FollowUp row={row} onSave={onSave} /></div>
          <textarea className="ab-note" rows={3} value={note}
            placeholder="Notes on this account. Saves as you type."
            onChange={(e) => onNote(row, e.target.value)} />
        </section>

        {err && <p className="ab-err">Could not load the detail: {err}</p>}
        {!data && !err && <p className="ab-dim">Loading…</p>}

        {data && (
          <>
            <section className="ab-sec">
              <h3 className="ab-h3">Purchases <span className="ab-ct">{data.sales.length}</span></h3>
              {byYear.length === 0 && <p className="ab-dim">No sales orders on record.</p>}
              {byYear.map(([year, list]) => (
                <div key={year} className="ab-yr">
                  <div className="ab-yr-h">
                    <span>{year}</span>
                    <span>{money(list.filter((s) => s.status === 'Invoiced').reduce((n, s) => n + Number(s.total || 0), 0))}</span>
                  </div>
                  {list.map((s) => (
                    <div key={s.id} className={`ab-sale${s.status !== 'Invoiced' ? ' ab-sale-off' : ''}`}>
                      <span className={`ab-kind ab-kind-${s.kind}`}>{KIND[s.kind] || s.kind}</span>
                      <span className="ab-sale-what">
                        {s.subject || s.product || s.qb_class}
                        {s.office && s.office !== office && <em> · {s.office}</em>}
                        {s.status !== 'Invoiced' && <em> · {s.status}</em>}
                      </span>
                      <span className="ab-sale-amt">{money(s.total)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>

            <section className="ab-sec">
              <h3 className="ab-h3">People <span className="ab-ct">{data.contacts.length}</span></h3>
              {data.contacts.length === 0 && <p className="ab-dim">Nobody on file in Zoho for this account.</p>}
              <ul className="ab-people">
                {(allPeople ? data.contacts : data.contacts.slice(0, 6)).map((c) => (
                  <li key={c.id}>
                    <div className="ab-p-main">
                      <span className="ab-p-name">{c.full_name}</span>
                      {c.title && <span className="ab-p-title">{c.title}</span>}
                    </div>
                    <div className="ab-p-reach">
                      {c.email_opt_out
                        ? <span className="ab-optout">Do not email</span>
                        : c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                      {(c.phone || c.mobile) && <span>{c.phone || c.mobile}</span>}
                    </div>
                  </li>
                ))}
              </ul>
              {data.contacts.length > 6 && !allPeople && (
                <button className="ab-link" onClick={() => setAllPeople(true)}>Show all {data.contacts.length}</button>
              )}
            </section>

            {data.lost.length > 0 && (
              <section className="ab-sec">
                <h3 className="ab-h3">Pitched, not closed <span className="ab-ct">{data.lost.length}</span></h3>
                {data.lost.map((o) => (
                  <div key={o.id} className="ab-sale ab-sale-off">
                    <span className={`ab-kind ab-kind-${o.kind}`}>{KIND[o.kind] || o.kind}</span>
                    <span className="ab-sale-what">
                      {o.name}<em> · {o.stage}{o.closing_date ? `, ${o.closing_date.slice(0, 4)}` : ''}</em>
                    </span>
                    <span className="ab-sale-amt">{o.amount ? money(o.amount) : ''}</span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        <section className="ab-sec">
          <h3 className="ab-h3">Recent mail</h3>
          {!row.domain && <p className="ab-dim">No web domain on file, so mail cannot be matched.</p>}
          {row.domain && !mail && <p className="ab-dim">Loading…</p>}
          {mail && mail.connected === false && (
            <p className="ab-dim">No mailbox is connected yet. Connect Outlook to see mail with {row.domain} here.</p>
          )}
          {mail && mail.connected !== false && mail.messages.length === 0 && (
            <p className="ab-dim">Nothing with {row.domain} in the connected mailboxes.</p>
          )}
          {mail && mail.messages.map((m, i) => (
            <div key={i} className="ab-mail">
              <span className="ab-mail-dir">{m.direction === 'out' ? 'Sent' : 'Received'}</span>
              <span className="ab-mail-sub">{m.subject || '(no subject)'}</span>
              <span className="ab-mail-when">{day(m.sent_at || m.date)}</span>
              {m.link && <a href={m.link} target="_blank" rel="noreferrer">Open in Outlook</a>}
            </div>
          ))}
        </section>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ board */

export default function AccountsBoard() {
  const [theme, setTheme] = useState('dark');
  const [office, setOffice] = useState('Texas');
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('active');      // a status, 'due', or 'all'
  const [q, setQ] = useState('');
  const [bought, setBought] = useState('');            // '' or a bought_* key
  const [open, setOpen] = useState(null);              // account_id
  const [notes, setNotes] = useState({});
  const [shown, setShown] = useState(100);
  const timers = useRef({});

  const series = `accounts:${office}`;

  useEffect(() => {
    let alive = true;
    setData(null); setErr(''); setOpen(null); setShown(100);
    getJSON(`/api/accounts?office=${encodeURIComponent(office)}`)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e.message); });
    getJSON(`/api/board-notes?series=${encodeURIComponent(series)}`)
      .then((d) => {
        if (!alive) return;
        const flat = {};
        for (const [k, v] of Object.entries(d.notes || {})) flat[k] = v.body || '';
        setNotes(flat);
      })
      .catch(() => { if (alive) setNotes({}); });
    return () => { alive = false; };
  }, [office, series]);

  // Stage / follow-up: change the screen first, then save. On failure, say so
  // and put the old value back — a silent revert reads as "it saved".
  const saveWork = useCallback((row, patch) => {
    const next = { stage: row.stage || '', follow_up_on: row.follow_up_on || '', ...patch };
    const apply = (vals) => setData((d) => d && ({
      ...d,
      accounts: d.accounts.map((a) => (a.account_id === row.account_id ? { ...a, ...vals } : a)),
    }));
    apply({ stage: next.stage || null, follow_up_on: next.follow_up_on || null });
    postJSON('/api/accounts', { account_id: row.account_id, office, ...next })
      .catch((e) => {
        apply({ stage: row.stage || null, follow_up_on: row.follow_up_on || null });
        setErr(`That change did not save: ${e.message}`);
      });
  }, [office]);

  const saveNote = useCallback((row, body) => {
    const key = `zoho:${row.account_id}`;
    setNotes((n) => ({ ...n, [key]: body }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      postJSON('/api/board-notes', { series, key, body })
        .catch((e) => setErr(`That note did not save: ${e.message}`));
    }, 800);
  }, [series]);

  const years = useMemo(() => {
    if (!data?.years) return [];
    const from = Math.max(data.years.min, data.years.max - 7);
    return Array.from({ length: data.years.max - from + 1 }, (_, i) => from + i);
  }, [data]);

  const dueCount = useMemo(
    () => (data ? data.accounts.filter((a) => a.follow_up_on && a.follow_up_on <= today()).length : 0),
    [data]
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    let list = data.accounts.filter((a) => {
      if (filter === 'due') { if (!(a.follow_up_on && a.follow_up_on <= today())) return false; }
      else if (filter !== 'all' && a.status !== filter) return false;
      if (bought && !a[bought]) return false;
      if (needle && !`${a.name} ${a.billing_city || ''} ${a.domain || ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    if (filter === 'due') list = [...list].sort((a, b) => a.follow_up_on.localeCompare(b.follow_up_on));
    return list;
  }, [data, filter, q, bought]);

  const openRow = data?.accounts.find((a) => a.account_id === open) || null;
  const pick = (f) => { setFilter(f); setShown(100); };

  return (
    <div className="ab-shell" data-theme={theme}>
      <aside className="ab-side">
        <div className="ab-brand">REJ<span>sales</span></div>
        <nav>
          <a className="ab-navi" href="/">Event sponsors</a>
          <span className="ab-navi ab-navi-on" aria-current="page">Ad accounts</span>
        </nav>
      </aside>

      <main className="ab-main">
        <div className="ab-top">
          <div>
            <p className="ab-eyebrow">{office}</p>
            <h1 className="ab-h1">Advertising accounts</h1>
            <p className="ab-sub">
              {data
                ? `${data.total.toLocaleString()} companies invoiced by the ${office} office since ${data.years?.min ?? ''}, from Zoho sales orders.`
                : 'Loading…'}
            </p>
          </div>
          <div className="ab-top-r">
            <select className="ab-picker" value={office} aria-label="Office"
              onChange={(e) => { setOffice(e.target.value); setFilter('active'); }}>
              {(data?.offices || ['Texas', 'Midwest', 'Minnesota']).map((o) => <option key={o}>{o}</option>)}
            </select>
            <button className="ab-themebtn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>

        {err && <p className="ab-err" role="alert">{err}</p>}

        {data && (
          <>
            <div className="ab-tiles">
              {STATUS_ORDER.map((s) => (
                <button key={s} className={`ab-tile${filter === s ? ' ab-tile-on' : ''}`} onClick={() => pick(s)}>
                  <span className="ab-tile-n">{data.counts[s] || 0}</span>
                  <span className="ab-tile-l">{STATUS[s].tile}</span>
                  <span className="ab-tile-h">{STATUS[s].hint}</span>
                </button>
              ))}
              <button className={`ab-tile ab-tile-due${filter === 'due' ? ' ab-tile-on' : ''}`} onClick={() => pick('due')}>
                <span className="ab-tile-n">{dueCount}</span>
                <span className="ab-tile-l">Follow-ups due</span>
                <span className="ab-tile-h">Dated today or earlier</span>
              </button>
            </div>

            <div className="ab-bar">
              <input className="ab-search" type="search" value={q} placeholder="Search company, city or domain"
                aria-label="Search accounts" onChange={(e) => { setQ(e.target.value); setShown(100); }} />
              <div className="ab-chips" role="group" aria-label="Has bought">
                <span className="ab-chips-l">Has bought</span>
                {BOUGHT.map(([key, label]) => (
                  <button key={key} className={`ab-chip${bought === key ? ' ab-chip-on' : ''}`}
                    aria-pressed={bought === key}
                    onClick={() => { setBought(bought === key ? '' : key); setShown(100); }}>{label}</button>
                ))}
              </div>
              <button className={`ab-chip${filter === 'all' ? ' ab-chip-on' : ''}`} onClick={() => pick('all')}>
                All {data.total}
              </button>
            </div>

            <div className="ab-panel">
              <div className="ab-legend">
                <span>{rows.length.toLocaleString()} {rows.length === 1 ? 'account' : 'accounts'}</span>
                <span className="ab-legend-k">
                  <i className="ab-y ab-y-ad" /> ad that year
                  <i className="ab-y ab-y-other" /> event or awards only
                  <i className="ab-y" /> nothing
                </span>
              </div>
              <div className="ab-scroll">
                <table className="ab-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th className="ab-th-years">
                        <span className="ab-years ab-years-h">{years.map((y) => <b key={y}>{String(y).slice(2)}</b>)}</span>
                      </th>
                      <th>Has bought</th>
                      <th>Status</th>
                      <th className="ab-num">Orders</th>
                      <th className="ab-num">Total</th>
                      <th>Stage</th>
                      <th>Follow up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, shown).map((r) => (
                      <tr key={r.account_id} onClick={() => setOpen(r.account_id)}
                        className={open === r.account_id ? 'ab-row-on' : ''}>
                        <td>
                          <button className="ab-co" onClick={(e) => { e.stopPropagation(); setOpen(r.account_id); }}>
                            <span className="ab-mono" aria-hidden="true">{monogram(r.name)}</span>
                            <span className="ab-co-t">
                              <span className="ab-co-n">{r.name}</span>
                              <span className="ab-co-s">
                                {place(r) || '—'}
                                {r.emailable === 0 && <em> · no emailable contact</em>}
                                {notes[`zoho:${r.account_id}`] && <em> · has a note</em>}
                              </span>
                            </span>
                          </button>
                        </td>
                        <td><YearStrip years={years} adYears={r.ad_years} saleYears={r.sale_years} /></td>
                        <td className="ab-bought">
                          {BOUGHT.filter(([k]) => r[k]).map(([k, label]) => <span key={k}>{label}</span>)}
                        </td>
                        <td>
                          <StatusPill status={r.status} />
                          <span className="ab-last">{r.last_ad_year ? `ad ${r.last_ad_year}` : `last ${r.last_year}`}</span>
                        </td>
                        <td className="ab-num">{r.orders}</td>
                        <td className="ab-num">{money(r.total)}</td>
                        <td className="ab-workcell"><StageSelect row={r} onSave={saveWork} compact /></td>
                        <td className="ab-workcell"><FollowUp row={r} onSave={saveWork} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && (
                <p className="ab-empty">
                  {filter === 'due'
                    ? 'No follow-ups are due. Set a follow-up date on any account and it will appear here on that day.'
                    : 'No accounts match that.'}
                </p>
              )}
              {rows.length > shown && (
                <button className="ab-more" onClick={() => setShown(shown + 200)}>
                  Show more ({(rows.length - shown).toLocaleString()} left)
                </button>
              )}
            </div>
          </>
        )}
      </main>

      {openRow && (
        <Detail row={openRow} office={office}
          note={notes[`zoho:${openRow.account_id}`] || ''}
          onNote={saveNote} onSave={saveWork} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
