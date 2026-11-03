// api/auth/callback.js — finish sign-in, set the session cookie.
//
//   GET /api/auth/callback?code=...&state=...
//
// Register this path as a SECOND redirect URI in Azure, alongside
// /api/outlook/callback. One app registration, two redirect URIs — Azure
// allows several, and they serve different purposes: this one proves identity,
// the other one connects a mailbox.

import { authority } from '../_outlook.js';
import { makeCookie } from '../_session.js';

export default async function handler(req, res) {
  const redirectUri = process.env.MS_AUTH_REDIRECT_URI;
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(
      `<p>Sign-in cancelled: ${error_description || error}</p><p><a href="/">Back</a></p>`
    );
  }
  if (!code) return res.status(400).send('No authorization code.');

  const cookie = String(req.headers.cookie || '');
  const expected = /(?:^|;\s*)auth_state=([^;]+)/.exec(cookie)?.[1];
  if (!expected || expected !== state) {
    return res.status(400).send(
      '<p>That sign-in link was stale. <a href="/api/auth/login">Try again</a>.</p>'
    );
  }
  const next = decodeURIComponent(/(?:^|;\s*)auth_next=([^;]+)/.exec(cookie)?.[1] || '/');

  try {
    const r = await fetch(`${authority()}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: 'openid profile email User.Read',
      }),
    });
    const tok = await r.json();
    if (!r.ok) throw new Error(tok.error_description || tok.error || `token ${r.status}`);

    const me = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((x) => x.json());

    const email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    if (!email) throw new Error('could not read the signed-in address');

    // No allow-list needed: the app registration is single-tenant, so Microsoft
    // will not issue a token to anyone outside this directory in the first place.
    res.setHeader('Set-Cookie', makeCookie({ email, name: me.displayName }));
    res.writeHead(302, { Location: next.startsWith('/') ? next : '/' });
    res.end();
  } catch (e) {
    res.status(500).send(
      `<p>Could not sign in: ${String(e.message).slice(0, 300)}</p>
       <p>Check that <code>${redirectUri}</code> is registered in Azure.</p>`
    );
  }
}
