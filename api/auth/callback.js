/* eslint-env node */
// api/auth/callback.js
// Completes the sign-in: swaps the authorization code for tokens, reads the
// user's name from Graph, and parks the access token in an HttpOnly cookie.
//
//   GET /api/auth/callback?code=...&state=...
//   -> 302 back to "/" with a session cookie set
//
// DEMO-SCOPE STORAGE. The access token lives in a cookie and expires in about
// an hour; the refresh token is deliberately NOT stored. Sign in again when it
// lapses. See db/ROADMAP.md for the durable version — that needs a tokens
// table, encryption at rest, and a refresh path, which is not two-days work.
//
// Env: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p.length === 2)
  );
}

export default async function handler(req, res) {
  const { code, state, error, error_description: desc } = req.query;

  if (error) {
    return res
      .status(400)
      .send(`<pre>Microsoft returned: ${error}\n\n${desc || ''}</pre>`);
  }
  if (!code) return res.status(400).send('No authorization code in the callback.');

  // The state cookie is missing when the browser dropped it (some private
  // windows) — warn rather than hard-fail, since this is a demo path.
  const expected = cookies(req).ms_state;
  if (expected && state && expected !== state) {
    return res.status(400).send('State mismatch — start again from /api/auth/login.');
  }

  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  const redirectUri = process.env.MS_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).send('MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REDIRECT_URI not set.');
  }

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }
    );
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`<pre>Token exchange failed:\n${JSON.stringify(tokens, null, 2)}</pre>`);
    }

    // Who signed in — shown in the header so it's obvious whose mail is being read.
    let who = '';
    try {
      const me = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }).then((r) => r.json());
      who = me.mail || me.userPrincipalName || me.displayName || '';
    } catch {
      /* non-fatal */
    }

    const maxAge = Math.max(60, (tokens.expires_in || 3600) - 120);
    const secure = redirectUri.startsWith('https') ? ' Secure;' : '';

    res.setHeader('Set-Cookie', [
      `ms_token=${tokens.access_token}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`,
      `ms_user=${encodeURIComponent(who)}; Path=/;${secure} SameSite=Lax; Max-Age=${maxAge}`,
      'ms_state=; Path=/; Max-Age=0',
    ]);

    res.writeHead(302, { Location: '/?connected=1' });
    res.end();
  } catch (err) {
    console.error('auth callback error:', err);
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
}
