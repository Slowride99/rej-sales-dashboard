import { useEffect, useState, useCallback, useImperativeHandle, forwardRef } from 'react';

/* ------------------------------------------------------------------ *
 * NotesColumn — the sales team's working area for one event.
 *
 * Two tabs:
 *   Notes    — shared with production. They see these on their tracker.
 *   Outreach — the sales log. Who was contacted, when, what happened.
 *
 * Sales has no Airtable access, so everything must be doable here:
 * add, read, and mark an outcome. Drafted emails log themselves.
 * ------------------------------------------------------------------ */

const C = {
  bg: '#12161c', panel: '#1a1f28', edge: '#252c38',
  ink: '#e8ecf2', soft: '#8e9aab', faint: '#5d6878',
  tx: '#BC2030', paid: '#4a9d6e', lapsed: '#c4863c', blocked: '#c4503c',
};

const FLAG_COLOR = {
  'FYI': C.faint,
  'Needs action': C.lapsed,
  'Blocked': C.blocked,
  'Resolved': C.paid,
};

const OUTCOME_COLOR = {
  'Sold': C.paid,
  'Interested': C.paid,
  'No response': C.faint,
  'Not this year': C.lapsed,
  'Declined': C.blocked,
};

const REPS = ['Jeff Johnson', 'Jay Kodytek', 'Ernie Abood', 'Frank Biondo', 'Matt Loarie'];
const CHANNELS = ['Email', 'Call', 'Meeting', 'LinkedIn', 'Event', 'Other'];
const OUTCOMES = ['', 'No response', 'Interested', 'Not this year', 'Declined', 'Sold'];

function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const NotesColumn = forwardRef(function NotesColumn({ event, companies = [] }, ref) {
  const [pane, setPane] = useState('notes');
  const [notes, setNotes] = useState([]);
  const [outreach, setOutreach] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  // shared note form
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState(REPS[0]);
  const [flag, setFlag] = useState('FYI');

  // outreach form
  const [oCompany, setOCompany] = useState('');
  const [oRep, setORep] = useState(REPS[0]);
  const [oChannel, setOChannel] = useState('Email');
  const [oSubject, setOSubject] = useState('');
  const [oNotes, setONotes] = useState('');
  const [oOutcome, setOOutcome] = useState('');
  const [oNext, setONext] = useState('');

  const load = useCallback(() => {
    if (!event?.id) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/notes?eventId=${event.id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setNotes(d.notes || []);
        setOutreach(d.outreach || []);
        setErr(null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [event?.id]);

  useEffect(() => { load(); }, [load]);

  // App calls this after a draft is copied or sent, so the log fills itself.
  useImperativeHandle(ref, () => ({ reload: load, showOutreach: () => setPane('outreach') }));

  async function post(payload) {
    setSaving(true);
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      load();
      return true;
    } catch (e) {
      setErr(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addNote(e) {
    e.preventDefault();
    if (!body.trim() || !event?.id) return;
    const ok = await post({
      kind: 'note', eventId: event.id, body: body.trim(),
      author, team: 'Sales', flag,
    });
    if (ok) { setBody(''); setFlag('FYI'); }
  }

  async function addOutreach(e) {
    e.preventDefault();
    if (!oCompany) { setErr('Pick a company'); return; }
    const ok = await post({
      kind: 'outreach',
      eventId: event?.id,
      companyId: oCompany,
      rep: oRep,
      channel: oChannel,
      subject: oSubject,
      notes: oNotes,
      outcome: oOutcome || undefined,
      nextStep: oNext,
      source: 'Manual',
    });
    if (ok) { setOSubject(''); setONotes(''); setOOutcome(''); setONext(''); }
  }

  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section style={s.col}>
      <header style={s.head}>
        <h2 style={s.title}>This event</h2>
        <span style={{ color: C.faint, fontSize: 13 }}>
          {pane === 'notes' ? notes.length : outreach.length}
        </span>
      </header>

      <div style={s.pills}>
        {[['notes', 'Notes'], ['outreach', 'Outreach log']].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setPane(id)}
            style={{ ...s.pill, ...(pane === id ? s.pillOn : {}) }}
          >{label}</button>
        ))}
      </div>

      {err && <p style={{ ...s.hint, color: '#ffb3bb' }}>{err}</p>}

      {pane === 'notes' && (
        <>
          <p style={s.hint}>Production sees these on their tracker.</p>

          <form onSubmit={addNote} style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
            <textarea
              style={s.textarea} rows={2}
              placeholder="Add a note both teams will see…"
              value={body} onChange={(e) => setBody(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <select style={s.select} value={author} onChange={(e) => setAuthor(e.target.value)}>
                {REPS.map((r) => <option key={r}>{r}</option>)}
              </select>
              <select style={s.select} value={flag} onChange={(e) => setFlag(e.target.value)}>
                {Object.keys(FLAG_COLOR).map((f) => <option key={f}>{f}</option>)}
              </select>
              <button style={s.btn} disabled={saving || !body.trim()}>
                {saving ? '…' : 'Add'}
              </button>
            </div>
          </form>

          <div style={{ display: 'grid', gap: 8 }}>
            {notes.map((n) => (
              <div key={n.id} style={{ ...s.card, borderLeft: `2px solid ${FLAG_COLOR[n.flag] || C.faint}` }}>
                <div style={s.cardTop}>
                  <span style={{ fontSize: 12, color: FLAG_COLOR[n.flag] || C.faint, fontWeight: 600 }}>
                    {n.flag}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.faint }}>{ago(n.created)}</span>
                </div>
                <div style={{ ...s.meta, color: C.ink, margin: '5px 0', lineHeight: 1.5 }}>{n.body}</div>
                <div style={{ ...s.meta, color: C.faint }}>
                  {n.author}{n.team ? ` · ${n.team}` : ''}
                </div>
              </div>
            ))}
            {!loading && notes.length === 0 && <p style={s.hint}>No notes yet.</p>}
          </div>
        </>
      )}

      {pane === 'outreach' && (
        <>
          <p style={s.hint}>Who was contacted about this event, and what came of it.</p>

          <form onSubmit={addOutreach} style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
            <select style={s.selectWide} value={oCompany} onChange={(e) => setOCompany(e.target.value)}>
              <option value="">Company…</option>
              {sorted.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input
              style={s.input} placeholder="Subject or what it was about"
              value={oSubject} onChange={(e) => setOSubject(e.target.value)}
            />
            <textarea
              style={s.textarea} rows={2} placeholder="Notes…"
              value={oNotes} onChange={(e) => setONotes(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <select style={s.select} value={oRep} onChange={(e) => setORep(e.target.value)}>
                {REPS.map((r) => <option key={r}>{r}</option>)}
              </select>
              <select style={s.select} value={oChannel} onChange={(e) => setOChannel(e.target.value)}>
                {CHANNELS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <select style={s.select} value={oOutcome} onChange={(e) => setOOutcome(e.target.value)}>
                {OUTCOMES.map((o) => <option key={o || 'none'} value={o}>{o || 'Outcome…'}</option>)}
              </select>
              <input
                style={{ ...s.input, flex: 1 }} placeholder="Next step"
                value={oNext} onChange={(e) => setONext(e.target.value)}
              />
              <button style={s.btn} disabled={saving || !oCompany}>
                {saving ? '…' : 'Log'}
              </button>
            </div>
          </form>

          <div style={{ display: 'grid', gap: 8 }}>
            {outreach.map((o) => (
              <div key={o.id} style={{
                ...s.card,
                borderLeft: `2px solid ${OUTCOME_COLOR[o.outcome] || C.edge}`,
              }}>
                <div style={s.cardTop}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {o.companyName || o.subject || o.channel}
                  </span>
                  <span style={{ fontSize: 11.5, color: C.faint }}>{ago(o.date)}</span>
                </div>
                {o.companyName && o.subject && (
                  <div style={{ ...s.meta, marginTop: 3 }}>{o.subject}</div>
                )}
                <div style={{ ...s.meta, color: C.faint, marginTop: 3 }}>
                  {[o.rep, o.channel, o.source].filter(Boolean).join(' · ')}
                </div>
                {o.outcome && (
                  <div style={{ ...s.meta, color: OUTCOME_COLOR[o.outcome] || C.soft, marginTop: 4 }}>
                    {o.outcome}
                  </div>
                )}
                {o.nextStep && (
                  <div style={{ ...s.meta, color: C.lapsed, marginTop: 4 }}>Next: {o.nextStep}</div>
                )}
              </div>
            ))}
            {!loading && outreach.length === 0 && (
              <p style={s.hint}>Nothing logged yet. Drafted emails log themselves.</p>
            )}
          </div>
        </>
      )}

      {loading && <p style={s.hint}>Loading…</p>}
    </section>
  );
});

export default NotesColumn;

const s = {
  col: { background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 8, padding: 16 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  pills: { display: 'flex', gap: 5, margin: '10px 0 8px' },
  pill: {
    background: 'transparent', color: C.faint, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
  },
  pillOn: { background: C.bg, color: C.ink, borderColor: C.tx },
  hint: { color: C.faint, fontSize: 12, margin: '4px 0 12px', lineHeight: 1.5 },
  card: { background: C.bg, border: `1px solid ${C.edge}`, borderRadius: 6, padding: 11 },
  cardTop: { display: 'flex', justifyContent: 'space-between', gap: 8 },
  meta: { color: C.soft, fontSize: 12.5, lineHeight: 1.45 },
  textarea: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: '8px 10px', fontSize: 13, resize: 'vertical',
    fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  },
  input: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: '7px 10px', fontSize: 13,
    width: '100%', boxSizing: 'border-box', minWidth: 0,
  },
  select: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '6px 8px', fontSize: 12, flex: 1, minWidth: 0,
  },
  selectWide: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '7px 9px', fontSize: 13,
    width: '100%', boxSizing: 'border-box',
  },
  btn: {
    background: C.tx, color: '#fff', border: 'none', borderRadius: 5,
    padding: '6px 14px', fontSize: 12.5, cursor: 'pointer',
    fontWeight: 500, whiteSpace: 'nowrap',
  },
};
