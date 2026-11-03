// api/auth/session.js — who am I?
//
//   GET /api/auth/session -> { signedIn, user, mailbox }
//
// `mailbox` answers the question the board kept raising: whose email am I
// looking at? It reports whether THIS person has connected their own mailbox,
// which is separate from being signed in.

import { readSession } from '../_session.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const me = readSession(req);
  if (!me) {
    return res.json({
      signedIn: false,
      // surfaced so the UI can stay usable while SESSION_SECRET is unset
      enforced: !!process.env.SESSION_SECRET,
    });
  }

  let mailbox = null;
  try {
    const rows = await fetch(
      `${SB}/rest/v1/outlook_accounts?user_email=eq.${encodeURIComponent(me.email)}` +
      '&select=user_email,last_sync_at,last_error',
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    ).then((r) => r.json());
    mailbox = rows?.[0] || null;
  } catch {
    // a lookup failure should never stop someone using the board
  }

  res.json({ signedIn: true, enforced: true, user: me, mailbox });
}
