import { useEffect, useState } from 'react';

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/prospects?market=TX')
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return r.json();
      })
      .then(setRows)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (error) return <div style={{ padding: 24, color: 'crimson' }}>Error: {error}</div>;

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Texas prospects ({rows.length})</h1>
      <ul>
        {rows.map((r) => (
          <li key={r.key}>
            <strong>{r.display_name}</strong>
            {' — '}
            {r.attendee_count} attendees, {r.events_attended} events,
            {' '}sponsored {r.times_sponsored}×
          </li>
        ))}
      </ul>
    </div>
  );
}