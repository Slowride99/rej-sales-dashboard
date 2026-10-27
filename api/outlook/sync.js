// api/outlook/sync.js — backfill and catch-up, plus manual subscribe.
//
//   GET /api/outlook/sync                  catch up since the newest message held
//   GET /api/outlook/sync?backfill=1       walk backwards through history
//   GET /api/outlook/sync?email=jeff@...   one account
//   GET /api/outlook/sync?subscribe=1      also (re)create the subscription
//   GET /api/outlook/sync?reset=1          restart the backfill from the top
//   GET /api/outlook/sync?pages=20         pages to walk this run (max 40)
//
// WHY NOT DELTA
//
// Graph has no mailbox-wide /me/messages/delta — change tracking for mail is
// scoped to a single folder (/me/mailFolders/{id}/messages/delta). Asking for
// the mailbox-wide form returns:
//
//   BadRequest: Change tracking is not supported against 'microsoft.graph.message'
//
// Walking folders one at a time would mean a deltaLink per folder and would
// still miss any folder created later. Plain paging over /me/messages covers
// the whole mailbox in one pass, so that is what this does.
//
// TWO MODES
//
//   catch-up (default) — newest first, stop at the newest message already
//     stored for this account. Cheap after the first run, and self-correcting:
//     the watermark is read from the data, so a failed run just repeats work
//     rather than skipping mail.
//
//   backfill — newest first via @odata.nextLink, saving the link so the next
//     run resumes. This is the one that pulls in history.
//
// The webhook keeps things current between runs; this exists so a missed
// notification or a lapsed subscription cannot leave a permanent hole.

import {
  envCheck, sb, accessTokenFor, graph, rowsFor, storeMessages, createSubscription,
} from '../_outlook.js';

const SELECT = [
  'id', 'internetMessageId', 'subject', 'sentDateTime', 'receivedDateTime',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'parentFolderId',
  'isDraft', 'webLink',
].join(',');

const BASE = process.env.APP_BASE_URL || '';
const MAX_PAGES = 40;
const PAGE = 50;

function authorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return !!(req.headers.authorization === `Bearer ${secret}`
         || req.query.secret === secret
         || req.headers['x-vercel-cron']);
}

/** Newest message we already hold for this account — the catch-up watermark.
 *  Derived from the data rather than stored, so it cannot drift out of sync
 *  with what was actually saved. */
async function watermark(accountId) {
  const [row] = await sb(
    `outlook_messages?account_id=eq.${accountId}&select=sent_at&order=sent_at.desc&limit=1`
  );
  return row?.sent_at || null;
}

export default async function handler(req, res) {
  const bad = envCheck();
  if (bad) return res.status(500).json({ error: bad });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorized' });

  const wantPages = Math.min(Number(req.query.pages) || 10, MAX_PAGES);
  const backfill = !!req.query.backfill;
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
      const line = { email: account.user_email, mode: backfill ? 'backfill' : 'catch-up',
                     stored: 0, scanned: 0, pages: 0 };
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

        const stopAt = backfill ? null : await watermark(account.id);
        line.caught_up_to = stopAt;

        let url;
        if (backfill && !reset && account.delta_link) {
          url = account.delta_link;                      // resume the walk
        } else {
          url = `/me/messages?$select=${SELECT}`
              + `&$orderby=receivedDateTime desc&$top=${PAGE}`;
        }

        let stored = 0, scanned = 0, pages = 0, nextLink = null, hitWatermark = false;

        while (url && pages < wantPages) {
          const page = await graph(url, at);
          pages++;

          const rows = [];
          for (const msg of page.value || []) {
            scanned++;
            // A draft was never sent. Counting one as outbound would invent
            // outreach that did not happen.
            if (msg.isDraft) continue;

            const when = msg.sentDateTime || msg.receivedDateTime;
            if (stopAt && when && when <= stopAt) { hitWatermark = true; break; }

            rows.push(...rowsFor(msg, account));
          }
          stored += await storeMessages(rows);

          if (hitWatermark) { url = null; break; }
          nextLink = page['@odata.nextLink'] || null;
          url = nextLink;
        }

        const patch = { last_sync_at: new Date().toISOString(), last_error: null };
        if (backfill) {
          // Only the backfill keeps a resume point. Saving one during catch-up
          // would skip whatever arrived while the walk was in progress.
          patch.delta_link = nextLink;
        }
        await sb(`outlook_accounts?id=eq.${account.id}`, {
          method: 'PATCH', body: JSON.stringify(patch),
        });

        line.stored = stored;
        line.scanned = scanned;
        line.pages = pages;
        line.complete = backfill ? !nextLink : (hitWatermark || !nextLink);
        if (!line.complete) line.note = 'more to go — run again to continue';
      } catch (e) {
        line.error = String(e.message).slice(0, 400);
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
