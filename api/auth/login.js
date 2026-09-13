/* eslint-env node */
// api/auth/login.js
// Starts the Microsoft sign-in. Each person authorizes their OWN mailbox —
// delegated permissions, not application permissions. No admin consent, no
// tenant-wide mailbox access, nothing needed from GoDaddy.
//
//   GET /api/auth/login  ->  302 to Microsoft
//
// Env:
//   MS_CLIENT_ID      Application (client) ID from the Entra app registration
//   MS_REDIRECT_URI   must match the registration EXACTLY, e.g.
//                     http://localhost:3000/api/auth/callback

const SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
].join(' ');

export default function handler(req, res) {
  const clientId = process.env.MS_CLIENT_ID;
  const redirectUri = process.env.MS_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: 'MS_CLIENT_ID and MS_REDIRECT_URI must be set in environment variables',
    });
  }

  // Random state, echoed back by Microsoft, checked in the callback.
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  res.setHeader(
    'Set-Cookie',
    `ms_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`
  );

  const url =
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize' +
    `?client_id=${encodeURIComponent(clientId)}` +
    '&response_type=code' +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_mode=query' +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${state}`;

  res.writeHead(302, { Location: url });
  res.end();
}
