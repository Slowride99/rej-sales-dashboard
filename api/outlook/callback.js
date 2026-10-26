// api/outlook/callback.js — finish sign-in, store the account, subscribe.
//
//   GET /api/outlook/callback?code=...&state=...
//
// Returns a plain HTML page rather than JSON, because a human is looking at
// this in a browser at the end of a consent flow — and on a screen share, a
// wall of JSON reads as "it broke".

import {
  envCheck, exchangeCode, graph, sb, createSubscription,
} from '../_outlook.js';

const BASE = process.env.APP_BASE_URL || '';

function page(title, body, ok = true) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#12161c;color:#e8ecf2;
      font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
 .box{max-width:460px;padding:32px;background:#1a1f28;border:1px solid #252c38;border-radius:10px}
 h1{font-size:19px;margin:0 0 12px;color:${ok ? '#3fa387' : '#c88029'}}
 p{margin:0 0 10px;color:#8e9aab} b{color:#e8ecf2}
 code{background:#12161c;padding:2px 6px;border-radius:4px;font-size:13px;color:#8e9aab}
 a{color:#BC2030}
</style></head><body><div class="box"><h1>${title}</h1>${body}</div></body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const bad = envCheck();
  if (bad) return res.status(500).send(page('Not configured', `<p>${bad}</p>`, false));

  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(page('Sign-in cancelled',
      `<p>${error_description || error}</p><p>Nothing was connected. You can close this tab.</p>`, false));
  }
  if (!code) return res.status(400).send(page('Missing code', '<p>No authorization code came back.</p>', false));

  const cookie = String(req.headers.cookie || '');
  const expected = /ol_state=([^;]+)/.exec(cookie)?.[1];
  if (!expected || expected !== state) {
    return res.status(400).send(page('Session expired',
      '<p>That sign-in link was stale. Start again from the dashboard.</p>', false));
  }

  try {
    const tok = await exchangeCode(code);

    // Who actually signed in. Never assume — the account chooser means this
    // can differ from whoever you expected.
    const me = await graph('/me', tok.access_token);
    const email = String(me.mail || me.userPrincipalName || '').toLowerCase();
    if (!email) throw new Error('could not read the signed-in address');

    const [account] = await sb('outlook_accounts?on_conflict=user_email', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        user_email: email,
        display_name: me.displayName || null,
        refresh_token: tok.refresh_token,
        access_token: tok.access_token,
        token_expires: new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
        scope: tok.scope || null,
        connected_at: new Date().toISOString(),
        last_error: null,
      }]),
    });

    let subNote = '';
    if (!BASE) {
      subNote = `<p><b>No live subscription yet.</b> Set <code>APP_BASE_URL</code> to this
        site's public https URL and hit <code>/api/outlook/sync?subscribe=1</code> —
        Microsoft has to be able to reach the notification endpoint from the
        outside, so it cannot be inferred from this request.</p>`;
    } else {
      try {
        const clientState = process.env.OUTLOOK_WEBHOOK_SECRET || 'rej-outlook';
        const sub = await createSubscription(account, tok.access_token, BASE, clientState);
        subNote = `<p>Live updates are on. New mail will appear against the right
          company within a minute or so.<br><span style="color:#5d6878">Subscription
          expires ${new Date(sub.expirationDateTime).toLocaleString()} and renews itself.</span></p>`;
      } catch (e) {
        subNote = `<p><b>Connected, but live updates did not start.</b><br>
          <code>${String(e.message).slice(0, 200)}</code><br>
          Usually this means Microsoft could not reach
          <code>${BASE}/api/outlook/notify</code>. History still imports; retry with
          <code>/api/outlook/sync?subscribe=1</code>.</p>`;
      }
    }

    return res.status(200).send(page('Outlook connected', `
      <p>Signed in as <b>${email}</b>.</p>
      ${subNote}
      <p style="margin-top:18px">This reads message headers only — who, when,
      subject line. The permission granted (<code>Mail.ReadBasic</code>) does not
      include message bodies, so they cannot be read even by mistake.</p>
      <p><a href="/">Back to the dashboard</a></p>`));
  } catch (e) {
    return res.status(500).send(page('Could not connect',
      `<p><code>${String(e.message).slice(0, 300)}</code></p>
       <p>Nothing was saved. Worth checking the redirect URI in Azure matches
       <code>${process.env.MS_REDIRECT_URI}</code> exactly.</p>`, false));
  }
}
