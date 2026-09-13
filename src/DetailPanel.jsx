import { useEffect, useState } from 'react';

/* ------------------------------------------------------------------ *
 * DetailPanel — one panel, used by both the sponsor and speaker views.
 *
 * Shows everything known about one company or person: history with
 * REJournals, contacts, and — when the rep has signed in with Microsoft —
 * their own recent email with that company.
 *
 * The mail section reads the SIGNED-IN USER'S OWN mailbox only.
 * ------------------------------------------------------------------ */

const C = {
  bg: '#12161c', panel: '#1a1f28', edge: '#252c38',
  ink: '#e8ecf2', soft: '#8e9aab', faint: '#5d6878',
  tx: '#BC2030', paid: '#4a9d6e', lapsed: '#c4863c',
};

const nums = { fontVariantNumeric: 'tabular-nums' };

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d) / 86400000);
  const stamp = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days === 0) return `Today · ${stamp}`;
  if (days === 1) return `Yesterday · ${stamp}`;
  if (days < 60) return `${days} days ago · ${stamp}`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months} months ago · ${stamp}`;
  return stamp;
}

function MailHistory({ company }) {
  const [state, setState] = useState({ loading: true, connected: false, user: '', messages: [] });

  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/mail?q=${encodeURIComponent(company)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) setState({ loading: false, ...d, messages: d.messages || [] }); })
      .catch(() => { if (alive) setState({ loading: false, connected: false, user: '', messages: [] }); });
    return () => { alive = false; };
  }, [company]);

  if (state.loading) return <p style={s.hint}>Checking your mail…</p>;

  if (!state.connected) {
    return (
      <div>
        <p style={s.hint}>
          Connect your Microsoft account to see your own email with this company.
          You authorize your own mailbox — nobody else&apos;s.
        </p>
        <a href="/api/auth/login" style={{ ...s.btn, textDecoration: 'none', display: 'inline-block' }}>
          Connect Outlook
        </a>
      </div>
    );
  }

  if (state.messages.length === 0) {
    return <p style={s.hint}>No email found with {company} in your mailbox.</p>;
  }

  const latest = state.messages[0];

  return (
    <div>
      <p style={{ ...s.hint, color: C.soft, marginBottom: 10 }}>
        Last contact {when(latest.date).toLowerCase()} · {state.messages.length} message
        {state.messages.length === 1 ? '' : 's'} in {state.user}
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {state.messages.slice(0, 6).map((m, i) => (
          <a key={i} href={m.link} target="_blank" rel="noreferrer" style={s.mailRow}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{m.subject}</span>
              <span style={{ ...nums, color: C.faint, fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {new Date(m.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
              </span>
            </div>
            <div style={{ ...s.meta, color: C.faint, marginTop: 3 }}>
              {m.from}{m.to ? ` → ${m.to}` : ''}
            </div>
            <div style={{ ...s.meta, marginTop: 5, lineHeight: 1.5 }}>{m.preview}</div>
          </a>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h3 style={s.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

export default function DetailPanel({ subject, kind, event, onClose, onDraft }) {
  if (!subject) return null;

  const name = kind === 'speaker'
    ? subject.name
    : (subject.display_name || subject.company);
  const org = kind === 'speaker' ? (subject.organization || subject.company) : null;

  // Sponsor History is one line per event, newest first.
  const history = (subject.history || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  return (
    <div style={s.overlay} onClick={onClose}>
      <aside style={s.drawer} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {subject.logo && (
            <img src={subject.logo} alt="" style={{
              width: 48, height: 48, objectFit: 'contain',
              background: '#fff', borderRadius: 5, padding: 4, boxSizing: 'border-box',
            }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 19, fontWeight: 600, margin: 0 }}>{name}</h2>
            {org && <p style={{ ...s.meta, margin: '3px 0 0' }}>{subject.title ? `${subject.title} · ` : ''}{org}</p>}
            {subject.website && (
              <a href={subject.website} target="_blank" rel="noreferrer"
                 style={{ ...s.meta, color: C.tx, textDecoration: 'none' }}>
                {String(subject.website).replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            )}
          </div>
          <button style={s.btn} onClick={onClose}>Close</button>
        </header>

        {kind !== 'speaker' && subject.reason && (
          <p style={{ ...s.meta, marginTop: 14, lineHeight: 1.6 }}>{subject.reason}</p>
        )}

        {kind !== 'speaker' && (
          <Section title="History with REJournals">
            <div style={s.statRow}>
              <Stat n={subject.attendee_count} label="attendees" />
              <Stat n={subject.events_attended} label="events" />
              <Stat n={subject.times_spoken} label="talks" />
              <Stat n={subject.times_sponsored} label="sponsorships"
                    color={subject.times_sponsored > 0 ? C.paid : C.faint} />
            </div>
            {subject.last_sponsored_year && (
              <p style={{ ...s.meta, marginTop: 10 }}>
                Last sponsored in{' '}
                <span style={{ ...nums, color: C.lapsed }}>{subject.last_sponsored_year}</span>
              </p>
            )}
          </Section>
        )}

        {history.length > 0 && (
          <Section title="Sponsored events">
            <div style={{ display: 'grid', gap: 5 }}>
              {history.slice(0, 12).map((h, i) => (
                <div key={i} style={{ ...s.meta, lineHeight: 1.5 }}>{h}</div>
              ))}
            </div>
          </Section>
        )}

        {subject.contacts?.length > 0 && (
          <Section title="Contacts">
            <div style={{ display: 'grid', gap: 6 }}>
              {subject.contacts.map((c, i) => (
                <div key={i} style={{ ...s.meta }}>
                  {c.name}
                  {c.email && (
                    <>
                      {' — '}
                      <a href={`mailto:${c.email}`} style={{ color: C.tx, textDecoration: 'none' }}>
                        {c.email}
                      </a>
                    </>
                  )}
                  {c.primary ? ' · primary' : ''}
                </div>
              ))}
            </div>
          </Section>
        )}

        {subject.email && kind === 'speaker' && (
          <Section title="Contact">
            <a href={`mailto:${subject.email}`} style={{ ...s.meta, color: C.tx, textDecoration: 'none' }}>
              {subject.email}
            </a>
          </Section>
        )}

        <Section title="Your email history">
          <MailHistory company={name} />
        </Section>

        {onDraft && kind !== 'speaker' && (
          <button
            style={{ ...s.btnPrimary, marginTop: 24, width: '100%' }}
            onClick={() => onDraft(subject)}
            disabled={!event}
          >
            Draft outreach for {event?.name || 'this event'}
          </button>
        )}
      </aside>
    </div>
  );
}

function Stat({ n, label, color }) {
  return (
    <div>
      <div style={{ ...nums, fontSize: 20, fontWeight: 600, color: color || C.ink }}>{n ?? 0}</div>
      <div style={{ ...s.meta, color: C.faint }}>{label}</div>
    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(8,10,14,.65)',
    display: 'flex', justifyContent: 'flex-end', zIndex: 60,
  },
  drawer: {
    background: C.panel, borderLeft: `1px solid ${C.edge}`,
    width: 'min(520px, 100%)', height: '100%', overflowY: 'auto',
    padding: 26, color: C.ink,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  sectionTitle: {
    fontSize: 13, fontWeight: 600, margin: '0 0 10px',
    color: C.soft, letterSpacing: '0.01em',
  },
  statRow: { display: 'flex', gap: 26, flexWrap: 'wrap' },
  meta: { color: C.soft, fontSize: 13, lineHeight: 1.5 },
  hint: { color: C.faint, fontSize: 13, lineHeight: 1.55, margin: '0 0 12px' },
  mailRow: {
    display: 'block', background: C.bg, border: `1px solid ${C.edge}`,
    borderRadius: 6, padding: 11, textDecoration: 'none', color: C.ink,
  },
  btn: {
    background: 'transparent', color: C.ink, border: `1px solid ${C.edge}`,
    borderRadius: 5, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer',
  },
  btnPrimary: {
    background: C.tx, color: '#fff', border: 'none', borderRadius: 5,
    padding: '11px 18px', fontSize: 14, cursor: 'pointer', fontWeight: 500,
  },
};
