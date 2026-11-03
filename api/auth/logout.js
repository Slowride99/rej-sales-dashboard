// api/auth/logout.js
//
//   GET /api/auth/logout
//
// Clears the local session only. It deliberately does NOT sign the person out
// of Microsoft — that would log them out of Outlook and Teams too, which is
// never what someone means by "log out of the dashboard".

import { clearCookie } from '../_session.js';

export default async function handler(req, res) {
  res.setHeader('Set-Cookie', clearCookie());
  res.writeHead(302, { Location: '/' });
  res.end();
}
