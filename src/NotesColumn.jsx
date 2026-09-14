import { useEffect, useState, useCallback } from 'react';

/* ------------------------------------------------------------------ *
 * NotesColumn — the shared card.
 *
 * Sales and production both write here and both see it on their own
 * dashboard. Production's materials chasing stays in Communications;
 * this is only for what the other team needs to know.
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

const REPS = ['Jeff Johnson', 'Jay Kodytek', 'Ernie Abood', 'Frank Biondo', 'Matt Loarie'];

function ago(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function NotesColumn({ event, refreshKey }) {
  const [notes, setNotes] = useState([]);
  const [outreach, setOutreach] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [author, setAuthor] = useState(REPS[0]);
  const [flag, setFlag] = useState('FYI');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

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

  useEffect(() => { load(); }, [load, refreshKey]);

  async function add(e) {
    e.preventDefault();
    if (!body.trim() || !event?.id) return;
    setSaving(true);
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'note',
          eventId: event.id,
          body: body.trim(),
          author,
          team: 'Sales',
          flag,
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setBody('');
      setFlag('FYI');
      load();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={s.col}>
      <header style={s.head}>
        <h2 style={s.title}>This event</h2>
        <span style={{ color: C.faint, fontSize: 13 }}>{notes.length + outreach.length}</span>
      </header>
      <p style={s.hint}>Shared with production. Recent outreach below.</p>

      <form onSubmit={add} style={{ display: 'grid', gap: 6, marginBottom: 14 }}>
        <textarea
          style={s.textarea}
          rows={2}
          placeholder="Add a note both teams will see…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <select style={s.select} value={author} onChange={(e) => setAuthor(e.target.value)}>
            {REPS.map((r) => <option key={r}>{r}</option>)}
          </select>
          <select style={s.select} value={flag} onChange={(e) => setFlag(e.target.value)}>
            {Object.keys(FLAG_COLOR).map((f) => <option key={f}>{f}</option>)}
          </select>
          <button style={s.btn} disabled={saving || !body.trim()}>
            {saving ? 'Saving…' : 'Add'}
          </button>
        </div>
      </form>

      {err && <p style={{ ...s.hint, color: '#ffb3bb' }}>{err}</p>}
      {loading && <p style={s.hint}>Loading…</p>}

      <div style={{ display: 'grid', gap: 8 }}>
        {notes.map((n) => (
          <div key={n.id} style={{ ...s.card, borderLeft: `2px solid ${FLAG_COLOR[n.flag] || C.faint}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
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

        {outreach.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ ...s.hint, marginBottom: 6 }}>Outreach logged</div>
            {outreach.slice(0, 8).map((o) => (
              <div key={o.id} style={{ ...s.card, marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{o.subject || o.channel}</span>
                  <span style={{ fontSize: 11.5, color: C.faint }}>{ago(o.date)}</span>
                </div>
                <div style={{ ...s.meta, color: C.faint, marginTop: 3 }}>
                  {[o.rep, o.channel, o.outcome].filter(Boolean).join(' · ')}
                </div>
                {o.nextStep && (
                  <div style={{ ...s.meta, color: C.lapsed, marginTop: 4 }}>Next: {o.nextStep}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {!loading && notes.length === 0 && outreach.length === 0 && (
          <p style={s.hint}>Nothing logged for this event yet.</p>
        )}
      </div>
    </section>
  );
}

const s = {
  col: { background: C.panel, border: `1px solid ${C.edge}`, borderRadius: 8, padding: 16 },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  hint: { color: C.faint, fontSize: 12, margin: '4px 0 12px', lineHeight: 1.5 },
  card: { background: C.bg, border: `1px solid ${C.edge}`, borderRadius: 6, padding: 11 },
  meta: { color: C.soft, fontSize: 12.5, lineHeight: 1.45 },
  textarea: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: '8px 10px', fontSize: 13, resize: 'vertical',
    fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  },
  select: {
    background: C.bg, color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '6px 8px', fontSize: 12, flex: 1, minWidth: 0,
  },
  btn: {
    background: C.tx, color: '#fff', border: 'none', borderRadius: 5,
    padding: '6px 14px', fontSize: 12.5, cursor: 'pointer', fontWeight: 500,
  },
};
