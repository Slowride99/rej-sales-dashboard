import { useEffect, useState, useCallback, useRef } from 'react';
import DetailPanel from './DetailPanel';
import NotesColumn from './NotesColumn';
 
/* ------------------------------------------------------------------ *
 * REJournals — Event Sales
 *
 * Sponsors: who has paid before, who is signed now, who to call.
 * Speakers: who is confirmed, who to invite.
 *
 * Every recommendation carries the numbers it was scored on, so "why is
 * this one here" always has an answer visible on the card.
 * ------------------------------------------------------------------ */

const MARKET = 'TX';
const YEAR = 2026;

const C = {
  bg: '#12161c',
  panel: '#1a1f28',
  edge: '#252c38',
  ink: '#e8ecf2',
  soft: '#8e9aab',
  faint: '#5d6878',
  tx: '#BC2030',
  paid: '#4a9d6e',
  lapsed: '#c4863c',
};

const nums = { fontVariantNumeric: 'tabular-nums' };

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y) return s;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function Logo({ src, size = 38 }) {
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
      style={{
        width: size, height: size, objectFit: 'contain',
        background: '#fff', borderRadius: 4, padding: 3,
        flexShrink: 0, boxSizing: 'border-box',
      }}
    />
  );
}

function Avatar({ src, name, size = 38 }) {
  const initials = String(name || '?')
    .split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (!src) {
    return (
      <div style={{
        width: size, height: size, borderRadius: '50%', flexShrink: 0,
        background: C.edge, color: C.soft, fontSize: 13,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{initials}</div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
    />
  );
}

/* ---------------------------------- cards --------------------------------- */

function CommittedCard({ s, onSelect }) {
  return (
    <div onClick={() => onSelect(s)} style={{ ...sx.card, cursor: 'pointer' }}>
      <div style={sx.row}>
        <Logo src={s.logo} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={sx.name}>{s.company}</div>
          <div style={{ ...sx.meta, color: C.paid }}>
            {s.tier}{s.status ? ` · ${s.status}` : ''}{s.signed ? ' · signed' : ''}
          </div>
        </div>
      </div>
      {s.soldBy && <div style={{ ...sx.meta, marginTop: 6 }}>Sold by {s.soldBy}</div>}
      {s.contacts?.length > 0 && (
        <div style={{ ...sx.meta, color: C.faint }}>
          {s.contacts.map((c) => c.name).filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  );
}

function PriorCard({ p, onSelect }) {
  return (
    <div onClick={() => onSelect(p)} style={{ ...sx.card, cursor: 'pointer' }}>
      <div style={sx.row}>
        <Logo src={p.logo} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={sx.name}>{p.display_name}</div>
          <div style={sx.meta}>
            <span style={nums}>{p.times_sponsored}</span> sponsorship
            {p.times_sponsored === 1 ? '' : 's'}, last in{' '}
            <span style={{ ...nums, color: C.lapsed }}>{p.last_sponsored_year}</span>
          </div>
          <div style={{ ...sx.meta, color: C.faint }}>
            <span style={nums}>{p.attendee_count}</span> attendees ·{' '}
            <span style={nums}>{p.events_attended}</span> events
          </div>
        </div>
      </div>
    </div>
  );
}

function ProspectCard({ r, event, onDraft, drafting, onSelect }) {
  return (
    <div
      onClick={() => onSelect(r)}
      style={{ ...sx.card, cursor: 'pointer', borderLeft: `2px solid ${r.is_lapsed ? C.lapsed : C.tx}` }}
    >
      <div style={sx.row}>
        <Logo src={r.logo} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div style={sx.name}>{r.display_name}</div>
            <div style={{ ...nums, color: C.faint, fontSize: 12 }}>{r.score}</div>
          </div>
          <div style={{ ...sx.meta, lineHeight: 1.5 }}>{r.reason}</div>
        </div>
      </div>
      <button
        style={{ ...sx.btn, marginTop: 10, width: '100%' }}
        onClick={(e) => { e.stopPropagation(); onDraft(r); }}
        disabled={drafting || !event}
      >
        {drafting ? 'Writing…' : 'Draft email'}
      </button>
    </div>
  );
}

function SpeakerCard({ s, confirmed, onSelect }) {
  return (
    <div
      onClick={() => onSelect(s)}
      style={{
        ...sx.card,
        cursor: 'pointer',
        borderLeft: confirmed ? `2px solid ${C.paid}` : undefined,
      }}
    >
      <div style={sx.row}>
        <Avatar src={s.headshot} name={s.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <div style={sx.name}>{s.name}</div>
            {!confirmed && <div style={{ ...nums, color: C.faint, fontSize: 12 }}>{s.score}</div>}
          </div>
          <div style={sx.meta}>
            {[s.title, s.organization || s.company].filter(Boolean).join(' · ')}
          </div>
          {!confirmed && <div style={{ ...sx.meta, color: C.faint }}>{s.reason}</div>}
        </div>
      </div>
    </div>
  );
}

function Column({ title, count, hint, children, empty, loading }) {
  return (
    <section style={sx.col}>
      <header style={sx.colHead}>
        <h2 style={sx.colTitle}>{title}</h2>
        <span style={{ ...nums, color: C.faint, fontSize: 13 }}>{count}</span>
      </header>
      {hint && <p style={sx.hint}>{hint}</p>}
      <div style={{ display: 'grid', gap: 8 }}>{children}</div>
      {!loading && count === 0 && <p style={sx.hint}>{empty}</p>}
    </section>
  );
}

/* ---------------------------------- draft --------------------------------- */

function DraftPanel({ draft, onClose, onLogged }) {
  const [copied, setCopied] = useState(false);
  if (!draft) return null;

  const copy = async () => {
    navigator.clipboard.writeText(`${draft.subject}\n\n${draft.body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
    if (draft.companyId && onLogged) {
      await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'outreach',
          eventId: draft.eventId,
          companyId: draft.companyId,
          channel: 'Email',
          subject: draft.subject,
          notes: draft.body,
          rep: draft.rep,
          source: 'Dashboard',
        }),
      });
      onLogged();
    }
  };
  
  const mailto = `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;

  return (
    <div style={sx.overlay} onClick={onClose}>
      <div style={sx.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...sx.meta, color: C.faint }}>Draft for {draft.company}</div>
        <div style={{ fontSize: 16, fontWeight: 600, margin: '10px 0 14px' }}>{draft.subject}</div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, fontSize: 14 }}>{draft.body}</div>

        {draft.facts?.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${C.edge}` }}>
            <div style={{ ...sx.meta, color: C.faint, marginBottom: 6 }}>Written from</div>
            {draft.facts.map((f, i) => (
              <div key={i} style={{ ...sx.meta, lineHeight: 1.6 }}>{f}</div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
          <button style={sx.btnPrimary} onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <a style={{ ...sx.btn, textDecoration: 'none' }} href={mailto}>Open in email</a>
          <button style={{ ...sx.btn, marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- app ---------------------------------- */

export default function App() {
  const [tab, setTab] = useState('sponsors');
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState('');
  const [board, setBoard] = useState({ committed: [], prior: [], recommended: [] });
  const [speakers, setSpeakers] = useState({ committed: [], recommended: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [question, setQuestion] = useState('');
  const [activeFilter, setActiveFilter] = useState(null);
  const [asking, setAsking] = useState(false);

  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState(null);
  const [draftingKey, setDraftingKey] = useState(null);

  const notesRef = useRef(null);
  const [companyList, setCompanyList] = useState([]);

  const event = events.find((e) => e.id === eventId) || null;

  useEffect(() => {
    fetch('/api/events?state=Texas')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setEvents(data);
        const now = new Date();
        const upcoming = data.find((e) => e.date && new Date(e.date) >= now);
        setEventId((upcoming || data[0])?.id || '');
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!eventId) return;
    fetch(`/api/notes?eventId=${eventId}`)
      .then((r) => r.json())
      .then((d) => setCompanyList(d.companies || []))
      .catch(() => {});
  }, [eventId]);

  const load = useCallback(() => {
    setLoading(true);

    const qs = new URLSearchParams({ market: MARKET, year: String(YEAR) });
    if (eventId) qs.set('eventId', eventId);

    const sqs = new URLSearchParams({ market: MARKET });
    if (eventId) sqs.set('eventId', eventId);
    if (event?.swoogoId) sqs.set('swoogoId', String(event.swoogoId));

    Promise.all([
      fetch(`/api/board?${qs}`).then((r) => r.json()),
      fetch(`/api/speakers?${sqs}`).then((r) => r.json()),
    ])
      .then(([b, s]) => {
        if (b.error) throw new Error(b.error);
        setBoard(b);
        if (!s.error) setSpeakers(s);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [eventId, event?.swoogoId]);

  useEffect(() => { load(); }, [load]);

  async function ask(e) {
    e?.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, year: YEAR }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error);
      setActiveFilter(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setAsking(false);
    }
  }

  async function draftFor(r) {
    setDraftingKey(r.key);
    try {
      const res = await fetch('/api/draft-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          company: r,
          event: event
            ? { name: event.name, date: fmtDate(event.date), location: event.location }
            : {},
          sender: { name: event?.owner || 'the REJournals events team' },
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDraft({
        ...data,
        company: r.display_name,
        companyId: r.airtableId,
        eventId: event?.id,
        rep: event?.owner,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setDraftingKey(null);
    }
  }

  // Applied to rows already on screen — no re-query, no generated SQL.
  function applyFilter(rows) {
    const f = activeFilter?.filter;
    if (!f) return rows;
    let out = rows.filter((r) => {
      if (f.never_sponsored === true && r.times_sponsored > 0) return false;
      if (f.lapsed === true && !r.is_lapsed) return false;
      if (f.last_sponsored_before != null && !(r.last_sponsored_year < f.last_sponsored_before)) return false;
      if (f.min_attendees != null && r.attendee_count < f.min_attendees) return false;
      if (f.min_events != null && r.events_attended < f.min_events) return false;
      if (f.min_award_entries != null && r.award_entries < f.min_award_entries) return false;
      if (f.has_spoken === true && !(r.times_spoken > 0)) return false;
      if (f.active_since != null && r.last_touch_year < f.active_since) return false;
      return true;
    });
    const by = {
      attendees: (a, b) => b.attendee_count - a.attendee_count,
      events: (a, b) => b.events_attended - a.events_attended,
      last_sponsored: (a, b) => (b.last_sponsored_year || 0) - (a.last_sponsored_year || 0),
      name: (a, b) => a.display_name.localeCompare(b.display_name),
      score: (a, b) => b.score - a.score,
    }[f.sort || 'score'];
    if (by) out = [...out].sort(by);
    if (f.limit) out = out.slice(0, f.limit);
    return out;
  }

  const recommended = applyFilter(board.recommended || []);

  return (
    <div style={sx.page}>
      <header style={sx.top}>
        <div style={{ minWidth: 0 }}>
          <p style={sx.eyebrow}>Event sales · Texas</p>
          <h1 style={sx.h1}>{event?.name || 'Loading…'}</h1>
          <p style={sx.sub}>
            {[
              event?.date && fmtDate(event.date),
              event?.location,
              event?.owner && `sold by ${event.owner}`,
              event?.prodOwner && `production ${event.prodOwner}`,
            ].filter(Boolean).join('  ·  ')}
          </p>
        </div>

        <select style={sx.select} value={eventId} onChange={(e) => setEventId(e.target.value)}>
          {events.length === 0 && <option>Loading events…</option>}
          {events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}{e.date ? ` — ${fmtDate(e.date)}` : ''}
            </option>
          ))}
        </select>
      </header>
      

      <nav style={sx.tabs}>
        {[['sponsors', 'Sponsors'], ['speakers', 'Speakers']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{ ...sx.tab, ...(tab === id ? sx.tabOn : {}) }}
          >{label}</button>
        ))}
      </nav>

      {error && <div style={sx.error}>{error}</div>}

      {tab === 'sponsors' && (
        <>
          <form onSubmit={ask} style={sx.askRow}>
            <input
              style={sx.input}
              placeholder="Ask for a list — who sponsored in 2023 but hasn't since?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button style={sx.btnPrimary} disabled={asking}>{asking ? 'Thinking…' : 'Ask'}</button>
            {activeFilter && (
              <button type="button" style={sx.btn}
                onClick={() => { setActiveFilter(null); setQuestion(''); }}>Clear</button>
            )}
          </form>

          {activeFilter && (
            <div style={{ ...sx.meta, color: C.tx, marginBottom: 14 }}>
              {activeFilter.label} · {recommended.length} of {board.recommended.length}
            </div>
          )}

          <div style={sx.grid}>
            <Column
              title="Sponsored before"
              count={board.prior.length}
              hint="Paid for a Texas event in the last five years."
              empty="No prior sponsors on record."
              loading={loading}
            >
              {board.prior.map((p) => (
              <PriorCard key={p.key} p={p} onSelect={(x) => setDetail({ subject: x, kind: 'sponsor' })} />
              ))}
            </Column>

            <Column
              title="Signed for this event"
              count={board.committed.length}
              hint="From the sponsor tracker production maintains."
              empty="Nothing signed yet for this event."
              loading={loading}
            >
              {board.committed.map((s) => (
              <CommittedCard key={s.id} s={s} onSelect={(x) => setDetail({ subject: x, kind: 'sponsor' })} />
              ))}
            </Column>

            <Column
              title="Worth a call"
              count={recommended.length}
              hint="Ranked by engagement and sponsorship gap. Anyone already signed is removed."
              empty="Nothing matches that filter."
              loading={loading}
            >
              {recommended.map((r) => (
              <ProspectCard
              key={r.key} r={r} event={event}
               onDraft={draftFor} drafting={draftingKey === r.key}
               onSelect={(x) => setDetail({ subject: x, kind: 'sponsor' })}
                 />
                ))}
            </Column>

            <NotesColumn ref={notesRef} event={event} companies={companyList} />

          </div>
        </>
      )}

      {tab === 'speakers' && (
        <div style={sx.grid}>
          <Column
            title="Confirmed"
            count={speakers.committed.length}
            hint="Linked to this event in Airtable."
            empty="No speakers confirmed yet."
            loading={loading}
          >
            {speakers.committed.map((s) => (
              <SpeakerCard
                key={s.id}
                s={s}
                confirmed
                onSelect={(x) => setDetail({ subject: x, kind: 'speaker' })}
              />
            ))}
          </Column>

          <Column
            title="Worth inviting"
            count={speakers.recommended.length}
            hint="People who have spoken at Texas events before, ranked by engagement and whether their company also buys."
            empty="No speaker history to draw on."
            loading={loading}
          >
            {speakers.recommended.map((s, i) => (
              <SpeakerCard
                key={`${s.name}-${i}`}
                s={s}
                onSelect={(x) => setDetail({ subject: x, kind: 'speaker' })}
              />
            ))}
          </Column>
        </div>
      )}

      {loading && <p style={sx.hint}>Loading…</p>}

      <DraftPanel
        draft={draft}
        onClose={() => setDraft(null)}
        onLogged={() => notesRef.current?.reload()}
      />

      <DetailPanel
        subject={detail?.subject}
        kind={detail?.kind}
        event={event}
        onClose={() => setDetail(null)}
        onDraft={(r) => { setDetail(null); draftFor(r); }}
      />
    </div>
  );
}


/* ---------------------------------- styles -------------------------------- */

const sx = {
  page: {
    background: C.bg, color: C.ink, minHeight: '100vh',
    padding: '28px 32px 60px',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  top: {
    display: 'flex', justifyContent: 'space-between',
    alignItems: 'flex-start', gap: 24, flexWrap: 'wrap', marginBottom: 20,
  },
  eyebrow: {
    color: C.tx, fontSize: 12, fontWeight: 600, margin: '0 0 6px',
    letterSpacing: '0.08em', textTransform: 'uppercase',
  },
  h1: {
    fontSize: 34, fontWeight: 600, margin: 0,
    letterSpacing: '-0.02em', lineHeight: 1.15,
  },
  sub: { color: C.soft, fontSize: 14.5, margin: '8px 0 0' },
  select: {
    background: C.panel, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: '9px 12px', fontSize: 14, minWidth: 320, maxWidth: '100%',
  },
  tabs: { display: 'flex', gap: 6, marginBottom: 18 },
  tab: {
    background: 'transparent', color: C.soft, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: '7px 16px', fontSize: 13.5, cursor: 'pointer',
  },
  tabOn: { background: C.panel, color: C.ink, borderColor: C.tx },
  askRow: { display: 'flex', gap: 8, margin: '0 0 12px', flexWrap: 'wrap' },
  input: {
    flex: 1, minWidth: 260, background: C.panel, color: C.ink,
    border: `1px solid ${C.edge}`, borderRadius: 6, padding: '9px 12px', fontSize: 14,
  },
  grid: {
    display: 'grid', gap: 16, alignItems: 'start',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  },
  col: { background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 8, padding: 16 },
  colHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  colTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
  hint: { color: C.faint, fontSize: 12, margin: '4px 0 12px', lineHeight: 1.5 },
  card: { background: C.bg, border: `1px solid ${C.edge}`, borderRadius: 6, padding: 12 },
  row: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  name: { fontSize: 14, fontWeight: 600, marginBottom: 3 },
  meta: { color: C.soft, fontSize: 12.5, lineHeight: 1.45 },
  btn: {
    background: 'transparent', color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer',
  },
  btnPrimary: {
    background: C.tx, color: '#fff', border: 'none', borderRadius: 5,
    padding: '9px 16px', fontSize: 13, cursor: 'pointer', fontWeight: 500,
  },
  error: {
    background: '#3a1a1e', border: '1px solid #6b2730', color: '#ffd7dc',
    borderRadius: 6, padding: '10px 14px', fontSize: 13, marginBottom: 14,
  },
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(8,10,14,.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 50,
  },
  modal: {
    background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 10,
    padding: 24, maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto',
  },
};
