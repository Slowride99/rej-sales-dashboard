/* eslint-env node */
// api/mail.js
// Reads the SIGNED-IN USER'S OWN mailbox through Microsoft Graph. Delegated
// permissions only — this can never reach anyone else's mail.
//
//   GET /api/mail?status=1          -> { connected, user }
//   GET /api/mail?q=Pace%20Group    -> { connected, user, messages: [...] }
//
// Answers "when did I last reach out to this company, and what for".

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
  );
}

// Graph $search wants a quoted phrase; strip characters that break the syntax.
function safeTerm(s) {
  return String(s).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export default async function handler(req, res) {
  const c = cookies(req);
  const token = c.ms_token;
  const user = c.ms_user ? decodeURIComponent(c.ms_user) : '';

  if (!token) {
    return res.status(200).json({ connected: false, user: '', messages: [] });
  }
  if (req.query.status) {
    return res.status(200).json({ connected: true, user, messages: [] });
  }

  const q = safeTerm(req.query.q || '');
  if (!q) return res.status(400).json({ error: 'q is required' });

  const top = Math.min(Number(req.query.top) || 8, 25);

  try {
    // $search covers subject, body and participants. It cannot be combined
    // with $orderby in Graph, so results come back by relevance and we sort
    // by date ourselves.
    const url =
      'https://graph.microsoft.com/v1.0/me/messages' +
      `?$search=${encodeURIComponent(`"${q}"`)}` +
      `&$top=${top}` +
      '&$select=subject,from,toRecipients,receivedDateTime,bodyPreview,webLink,isDraft';

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ConsistencyLevel: 'eventual',
      },
    });
    const data = await r.json();

    if (!r.ok) {
      const msg = data?.error?.message || `Graph ${r.status}`;
      // Expired token reads as "not connected" so the UI offers sign-in again.
      if (r.status === 401) {
        return res.status(200).json({ connected: false, user: '', messages: [], note: msg });
      }
      throw new Error(msg);
    }

    const messages = (data.value || [])
      .filter((m) => !m.isDraft)
      .map((m) => ({
        subject: m.subject || '(no subject)',
        from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || '',
        fromAddress: m.from?.emailAddress?.address || '',
        to: (m.toRecipients || [])
          .map((t) => t.emailAddress?.name || t.emailAddress?.address)
          .filter(Boolean)
          .join(', '),
        date: m.receivedDateTime,
        preview: (m.bodyPreview || '').slice(0, 180),
        link: m.webLink,
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({ connected: true, user, query: q, messages });
  } catch (err) {
    console.error('mail error:', err);
    return res.status(500).json({ error: err.message || 'Mail search failed' });
  }
}
