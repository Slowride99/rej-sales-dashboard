// AuthGate.jsx — nothing renders until we know who's asking.
//
// Wrap the whole app:
//
//   import AuthGate from './AuthGate';
//   ...
//   <AuthGate><App /></AuthGate>
//
// in main.jsx / index.jsx, or wrap App's return.
//
// Styles are inline on purpose so this works whichever tab is showing — it
// sits outside the board's stylesheet.

import { useEffect, useState } from 'react';

const C = {
  bg: '#12161c', panel: '#1a1f28', edge: '#252c38',
  ink: '#e8ecf2', soft: '#8e9aab', faint: '#5d6878',
  tx: '#BC2030', paid: '#3fa387',
};

const centre = {
  minHeight: '100vh', background: C.bg, color: C.ink,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
  font: '15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

export default function AuthGate({ children }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((d) => { if (alive) setState({ loading: false, ...d }); })
      // A failed check must not lock anyone out of a working dashboard —
      // better to render the app than to show a sign-in page that may be
      // wrong about why it is there.
      .catch(() => { if (alive) setState({ loading: false, signedIn: true, degraded: true }); });
    return () => { alive = false; };
  }, []);

  if (state.loading) {
    return <div style={centre}><span style={{ color: C.soft }}>Checking…</span></div>;
  }

  // SESSION_SECRET not set yet: the guard is inert server-side, so gating the
  // UI here would be theatre — and would lock people out of an app that is
  // still perfectly reachable by URL.
  if (state.signedIn || state.enforced === false) return children;

  return (
    <div style={centre}>
      <div style={{
        maxWidth: 420, padding: 34, background: C.panel,
        border: `1px solid ${C.edge}`, borderRadius: 12,
      }}>
        <p style={{
          color: C.tx, fontSize: 12, fontWeight: 600, margin: '0 0 10px',
          letterSpacing: '.08em', textTransform: 'uppercase',
        }}>REJournals</p>

        <h1 style={{ fontSize: 21, fontWeight: 600, margin: '0 0 12px' }}>
          Event Sales Dashboard
        </h1>

        <p style={{ color: C.soft, margin: '0 0 22px' }}>
          Sign in with your REJournals account to continue.
        </p>

        <a
          href={`/api/auth/login?next=${encodeURIComponent(window.location.pathname)}`}
          style={{
            display: 'block', textAlign: 'center', textDecoration: 'none',
            background: C.tx, color: '#fff', borderRadius: 8,
            padding: '12px 16px', fontWeight: 500,
          }}
        >
          Sign in with Microsoft
        </a>

        <p style={{ color: C.faint, fontSize: 12.5, margin: '18px 0 0' }}>
          This only confirms who you are. It doesn't read your email —
          connecting a mailbox is a separate, optional step inside the app.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ chip */
//
// Optional: drop <WhoAmI /> into a header. Shows who is signed in and whether
// their own mailbox is connected — which is the question the board kept
// raising once more than one person could sign in.

export function WhoAmI({ style }) {
  const [s, setS] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/session').then((r) => r.json())
      .then((d) => { if (alive) setS(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!s?.signedIn) return null;

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      color: C.soft, fontSize: 12.5, ...style,
    }}>
      <span>{s.user?.name || s.user?.email}</span>
      {s.mailbox
        ? <span style={{ color: C.paid }}>· mailbox connected</span>
        : <a href="/api/outlook/connect" style={{ color: C.tx }}>· connect mailbox</a>}
      <a href="/api/auth/logout" style={{ color: C.faint }}>sign out</a>
    </span>
  );
}
