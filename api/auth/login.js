// api/auth/login.js — sign in to the dashboard.
//
//   GET /api/auth/login[?next=/path]
//
// Deliberately NOT the same thing as connecting a mailbox. This asks only for
// identity (User.Read), so anyone on the team can open the board without
// handing over their email. Connecting a mailbox is a separate, optional
// consent at /api/outlook/connect.
//
// Keeping them apart matters: bundling them would mean someone who just wants
// to look at sponsor numbers has to approve mailbox access, which is both more
// than they need and a much easier thing to say no to.

import { authority } from '../_outlook.js';

const SIGNIN_SCOPES = 'openid profile email User.Read';

export default async function handler(req, res) {
  const redirectUri = process.env.MS_AUTH_REDIRECT_URI;
  if (!process.env.MS_CLIENT_ID || !redirectUri || !process.env.SESSION_SECRET) {
    return res.status(500).json({
      error: 'missing env: MS_CLIENT_ID, MS_AUTH_REDIRECT_URI, SESSION_SECRET',
    });
  }

  // `next` lets a 401 bounce someone back where they were. Only a relative
  // path is accepted — an absolute URL here would turn the sign-in into an
  // open redirect anyone could aim at a site of their choosing.
  const next = String(req.query.next || '/');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  const state = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;

  const url = `${authority()}/authorize?` + new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SIGNIN_SCOPES,
    state,
    prompt: 'select_account',
  });

  res.setHeader('Set-Cookie', [
    `auth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    `auth_next=${encodeURIComponent(safeNext)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);
  res.writeHead(302, { Location: url });
  res.end();
}
