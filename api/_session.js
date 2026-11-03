// api/_session.js — who is asking.
//
// A signed cookie, not a database session. There is no session table to keep,
// nothing to clean up, and a stolen cookie expires on its own. The signature is
// HMAC-SHA256 over the payload with SESSION_SECRET, so a cookie cannot be
// forged or edited without the secret.
//
// WHY THIS EXISTS AT ALL
//
// The dashboard is a public URL. Read-only sponsor data on an unguessable URL
// is a small risk; a "send mail as Jeff" button on one is a phishing tool with
// the CEO's name on it. So the gate goes in before the send button, not after.
//
// WHO GETS IN
//
// The app registration is single-tenant, so Microsoft will only ever issue a
// token to a Real Estate Summits / REJournals account. That is the access
// control, and it comes free — this file just records the result.
//
// Env:
//   SESSION_SECRET   any long random string
//   SESSION_DAYS     optional, default 30

import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || '';
const DAYS = Number(process.env.SESSION_DAYS) || 30;
export const COOKIE = 'rej_session';

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** Build the Set-Cookie value for a signed-in user. */
export function makeCookie({ email, name }) {
  const body = b64(JSON.stringify({
    email: String(email).toLowerCase(),
    name: name || '',
    exp: Date.now() + DAYS * 86400_000,
  }));
  const token = `${body}.${sign(body)}`;
  return [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',                 // not readable from JavaScript
    'Secure',
    'SameSite=Lax',             // survives the OAuth redirect back from Microsoft
    `Max-Age=${DAYS * 86400}`,
  ].join('; ');
}

export const clearCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The signed-in user, or null. Never throws — a bad cookie is just no session. */
export function readSession(req) {
  if (!SECRET) return null;
  const raw = /(?:^|;\s*)rej_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!raw) return null;

  const [body, sig] = raw.split('.');
  if (!body || !sig) return null;

  // timingSafeEqual needs equal lengths, and throws otherwise
  const expected = sign(body);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(unb64(body));
    if (!data.exp || data.exp < Date.now()) return null;
    return { email: data.email, name: data.name };
  } catch {
    return null;
  }
}

/** Guard for an API route. Returns the user, or answers 401 and returns null.
 *
 *  Usage at the top of a handler:
 *
 *      const me = requireSession(req, res);
 *      if (!me) return;
 *
 *  Deliberately fails OPEN when SESSION_SECRET is unset, so adding this to
 *  every endpoint cannot lock you out of your own app before the variable is
 *  set. Set SESSION_SECRET and it is enforced everywhere at once.
 */
export function requireSession(req, res) {
  if (!SECRET) return { email: 'anonymous', name: '', unguarded: true };
  const me = readSession(req);
  if (!me) {
    res.status(401).json({ error: 'not signed in', signIn: '/api/auth/login' });
    return null;
  }
  return me;
}
