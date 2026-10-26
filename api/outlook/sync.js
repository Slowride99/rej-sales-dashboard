// api/outlook/sync.js — backfill and catch-up, plus manual subscribe.
//
//   GET /api/outlook/sync                  all connected accounts, resume delta
//   GET /api/outlook/sync?email=jeff@...   one account
//   GET /api/outlook/sync?subscribe=1      also (re)create the subscription
//   GET /api/outlook/sync?reset=1          start the delta over from scratch
//   GET /api/outlook/sync?pages=5          how many pages to walk this run
//
// WHY THIS EXISTS ALONGSIDE THE WEBHOOK
//
// Webhooks miss things. Subscriptions lapse, notifications get dropped, the
// function times out mid-burst, the site is redeploying when mail arrives.
// A delta query is the authoritative catch-up: Graph hands back a deltaLink
// that means "everything since last time", so running this on a schedule makes
// the index self-healing. The webhook is for latency; this is for correctness.
//
// Protect it with CRON_SECRET once it is on a schedule, or anyone can make you
// walk Jeff's mailbox by loading a URL.

import {
  envCheck, sb, accessTokenFor, graph, rowsFor, storeMessages, createSubscription,
} from '../_outlook.js';

const SELECT = [
  'id', 'internetMessageId', 'subject', 'sentDateTime', 'receivedDateTime',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'parentFolderId',
].join(',');

const BASE = process.env.APP_BASE_URL || '';
const MAX_PAGES = 40;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;                      // not set: open, fine while testing
  const given = req.headers.authorization === `Bearer ${secret}`
             || req.query.secret === secret
             || req.headers['x-vercel-cron'];    // Vercel's own scheduler
  return !!given;
}

export default async function handler(req, res) {
  const bad = envCheck();
  if (bad) return res.status(500).json({ error: bad });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorized' });

  const wantPages = Math.min(Number(req.query.pages) || 10, MAX_PAGES);
  const reset = !!req.query.reset;
  const subscribe = !!req.query.subscribe;

  try {
    const filter = req.query.email
      ? `user_email=eq.${encodeURIComponent(String(req.query.email).toLowerCase())}`
      : '';
    const accounts = await sb(`outlook_accounts?${filter}${filter ? '&' : ''}select=*`);
    if (!accounts?.length) {
      return res.json({ accounts: 0, note: 'nothing connected — visit /api/outlook/connect' });
    }

    const report = [];

    for (const account of accounts) {
      const line = { email: account.user_email, stored: 0, pages: 0 };
      try {
        const at = await accessTokenFor(account);

        if (subscribe) {
          if (!BASE) {
            line.subscription = 'APP_BASE_URL not set — cannot subscribe';
          } else {
            const sub = await createSubscription(
              account, at, BASE, process.env.OUTLOOK_WEBHOOK_SECRET || 'rej-outlook'
            );
            line.subscription = `expires ${sub.expirationDateTime}`;
          }
        }

        // Resume where we left off unless told to start over. The deltaLink
        // already encodes the filter and select, so it is used verbatim.
        let url = (!reset && account.delta_link)
          ? account.delta_link
          : `/me/messages/delta?$select=${SELECT}`;

        let stored = 0, pages = 0, nextDelta = null;

        while (url && pages < wantPages) {
          const page = await graph(url, at, {
            headers: { Prefer: 'odata.maxpagesize=50' },
          });
          pages++;

          const rows = [];
          for (const msg of page.value || []) {
            // deltas include removals, which carry no addresses
            if (msg['@removed'] || !msg.id) continue;
            rows.push(...rowsFor(msg, account));
          }
          stored += await storeMessages(rows);

          if (page['@odata.nextLink']) { url = page['@odata.nextLink']; }
          else { nextDelta = page['@odata.deltaLink'] || null; url = null; }
        }

        // Only save a deltaLink when the walk actually finished. Saving one
        // mid-walk would skip everything we hadn't read yet, permanently.
        const patch = { last_sync_at: new Date().toISOString(), last_error: null };
        if (nextDelta) patch.delta_link = nextDelta;
        else if (reset) patch.delta_link = null;
        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        });

        line.stored = stored;
        line.pages = pages;
        line.complete = !!nextDelta;
        if (!nextDelta) line.note = 'more pages remain — run again to continue';
      } catch (e) {
        line.error = String(e.message).slice(0, 300);
        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ last_error: `sync: ${line.error}` }),
        }).catch(() => {});
      }
      report.push(line);
    }

    return res.json({ accounts: report.length, report });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
