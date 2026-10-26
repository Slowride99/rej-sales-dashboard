// api/outlook/connect.js — start the Microsoft sign-in.
//
//   GET /api/outlook/connect   -> 302 to the Microsoft consent screen
//
// Delegated OAuth: Jeff signs in as himself and approves reading his own
// mailbox. No admin consent, no tenant-wide permission, nothing to do with
// federation. The app can only ever see the mailbox of whoever signed in.

import { authority, SCOPES, envCheck } from '../_outlook.js';

export default async function handler(req, res) {
  const bad = envCheck();
  if (bad) return res.status(500).json({ error: bad });

  // state ties the callback to this attempt. It is not a security boundary on
  // its own — the token exchange is — but it stops a stale or replayed
  // callback from being processed as a fresh connection.
  const state = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;

  const url = `${authority()}/authorize?` + new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES,
    state,
    // Forces the account chooser. Without it, a browser already signed in as
    // someone else connects the WRONG mailbox silently — which on a shared
    // screen-share is exactly how you end up indexing the wrong person.
    prompt: 'select_account',
  });

  res.setHeader('Set-Cookie',
    `ol_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  res.writeHead(302, { Location: url });
  res.end();
}
