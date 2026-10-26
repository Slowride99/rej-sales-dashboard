// api/cron/outlook-renew.js — keep subscriptions alive.
//
//   GET /api/cron/outlook-renew
//
// Graph subscriptions expire. A lapsed one does not error — it simply stops
// delivering, and the board quietly goes stale while looking completely
// healthy. That silence is the whole risk, so this runs on a schedule and
// renews anything inside its halfway point.
//
// It renews by PATCHing a new expirationDateTime, and stores WHAT GRAPH
// RETURNS rather than what it asked for. If the account has gone bad (password
// change, consent revoked, mailbox moved) the renewal fails, and this records
// it on the account so there is somewhere to look.
//
// Schedule in vercel.json:
//   { "crons": [{ "path": "/api/cron/outlook-renew", "schedule": "0 */6 * * *" }] }
//
// Vercel's Hobby plan only permits daily crons; Pro allows this. Daily still
// works against a ~3-day expiry, but leaves far less margin for a failed run.

import { sb, accessTokenFor, graph, REQUESTED_MINUTES } from '../_outlook.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const ok = req.headers.authorization === `Bearer ${secret}`
            || req.query.secret === secret
            || req.headers['x-vercel-cron'];
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const subs = await sb('outlook_subscriptions?select=*');
    if (!subs?.length) return res.json({ checked: 0, renewed: 0 });

    const now = Date.now();
    const report = [];
    let renewed = 0;

    for (const sub of subs) {
      const expires = new Date(sub.expires_at).getTime();
      const created = new Date(sub.renewed_at || sub.created_at).getTime();
      const halfway = created + (expires - created) / 2;

      // Renew past the halfway mark. Waiting until nearly expired means one
      // failed cron run loses the subscription; renewing every run wastes
      // calls. Halfway gives a whole cycle of slack.
      if (now < halfway && expires > now) {
        report.push({ subscription: sub.subscription_id, action: 'still fresh',
                      expires: sub.expires_at });
        continue;
      }

      const [account] = await sb(`outlook_accounts?id=eq.${sub.account_id}&select=*`);
      if (!account) {
        report.push({ subscription: sub.subscription_id, action: 'orphaned — no account' });
        continue;
      }

      try {
        const at = await accessTokenFor(account);
        const updated = await graph(`/subscriptions/${encodeURIComponent(sub.subscription_id)}`, at, {
          method: 'PATCH',
          body: JSON.stringify({
            expirationDateTime: new Date(Date.now() + REQUESTED_MINUTES * 60_000).toISOString(),
          }),
        });

        await sb(`outlook_subscriptions?id=eq.${sub.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            expires_at: updated.expirationDateTime,
            renewed_at: new Date().toISOString(),
          }),
        });

        renewed++;
        report.push({ subscription: sub.subscription_id, action: 'renewed',
                      expires: updated.expirationDateTime, email: account.user_email });
      } catch (e) {
        const msg = String(e.message).slice(0, 300);

        // 404: Graph has already dropped it. The row is a corpse — delete it
        // and re-subscribe, rather than retrying a dead id every six hours.
        if (e.status === 404 || e.status === 410) {
          await sb(`outlook_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' }).catch(() => {});
          report.push({ subscription: sub.subscription_id, action: 'gone — removed',
                        email: account.user_email,
                        fix: `GET /api/outlook/sync?subscribe=1&email=${account.user_email}` });
        } else {
          report.push({ subscription: sub.subscription_id, action: 'failed', error: msg });
        }

        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ last_error: `renew: ${msg}` }),
        }).catch(() => {});
      }
    }

    return res.json({ checked: subs.length, renewed, report });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
