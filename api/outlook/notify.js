// api/outlook/notify.js — where Microsoft delivers change notifications.
//
//   POST /api/outlook/notify?validationToken=...   (the handshake)
//   POST /api/outlook/notify                       (actual notifications)
//
// TWO THINGS THIS ENDPOINT MUST GET RIGHT
//
// 1. The validation handshake. When a subscription is created, Graph
//    immediately POSTs here with a ?validationToken= query parameter and
//    expects 200, Content-Type text/plain, body = the token verbatim, within
//    about 10 seconds. Anything else — JSON, a redirect, an auth challenge,
//    being slow — and the subscription is simply never created. This is the
//    single most common reason "it connected but nothing arrives".
//
// 2. Answering fast. Notifications are fire-and-forget; Graph retries on
//    failure and drops the subscription after repeated failures. Since the
//    delta sync in sync.js is a complete backstop, this endpoint always
//    answers 202 — even when processing failed — and records the error on the
//    account instead. A retry storm that kills the subscription is worse than
//    a missed message the next delta run would have picked up anyway.

import { sb, accessTokenFor, graph, rowsFor, storeMessages } from '../_outlook.js';

const SELECT = [
  'id', 'internetMessageId', 'subject', 'sentDateTime', 'receivedDateTime',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'parentFolderId',
].join(',');

// A single notification burst is capped. Anything beyond this is left for the
// delta sync rather than risking the function timing out mid-batch.
const MAX_PER_BURST = 25;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  // ---- 1. the handshake. Before anything else, and never JSON. ----
  const token = req.query?.validationToken;
  if (token) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(String(token));
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  let payload;
  try { payload = await readBody(req); }
  catch { return res.status(202).end(); }   // malformed: ack, don't make Graph retry

  const items = Array.isArray(payload.value) ? payload.value : [];
  if (!items.length) return res.status(202).end();

  try {
    const expected = process.env.OUTLOOK_WEBHOOK_SECRET || 'rej-outlook';

    // Anyone can POST here — the URL is public by necessity. clientState is
    // what proves a notification came from our own subscription. Drop silently
    // rather than erroring, so a prober learns nothing from the response.
    const valid = items.filter((i) => i.clientState === expected);
    if (!valid.length) return res.status(202).end();

    // Lifecycle events ("your subscription needs attention") arrive in the same
    // shape. Flag the account; the renewal cron handles the repair.
    const lifecycle = valid.filter((i) => i.lifecycleEvent);
    for (const l of lifecycle) {
      await sb(`outlook_subscriptions?subscription_id=eq.${encodeURIComponent(l.subscriptionId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ expires_at: new Date().toISOString() }),  // forces renewal next run
      }).catch(() => {});
    }

    const changes = valid.filter((i) => !i.lifecycleEvent && i.resourceData?.id)
                         .slice(0, MAX_PER_BURST);
    if (!changes.length) return res.status(202).end();

    // Group by subscription so one Graph token covers each account's batch.
    const bySub = new Map();
    for (const c of changes) {
      if (!bySub.has(c.subscriptionId)) bySub.set(c.subscriptionId, []);
      bySub.get(c.subscriptionId).push(c.resourceData.id);
    }

    for (const [subId, ids] of bySub) {
      const [sub] = await sb(
        `outlook_subscriptions?subscription_id=eq.${encodeURIComponent(subId)}&select=account_id`
      );
      if (!sub) continue;

      const [account] = await sb(`outlook_accounts?id=eq.${sub.account_id}&select=*`);
      if (!account) continue;

      try {
        const at = await accessTokenFor(account);
        const rows = [];
        for (const id of ids) {
          try {
            const msg = await graph(`/me/messages/${encodeURIComponent(id)}?$select=${SELECT}`, at);
            rows.push(...rowsFor(msg, account));
          } catch (e) {
            // 404 is normal and not an error: the message was moved or deleted
            // between the notification firing and us fetching it.
            if (e.status !== 404) throw e;
          }
        }
        await storeMessages(rows);
        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ last_sync_at: new Date().toISOString(), last_error: null }),
        });
      } catch (e) {
        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ last_error: `notify: ${String(e.message).slice(0, 300)}` }),
        }).catch(() => {});
      }
    }
  } catch {
    // swallowed on purpose — see the note at the top
  }

  return res.status(202).end();
}
