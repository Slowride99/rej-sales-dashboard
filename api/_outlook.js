// api/_outlook.js — shared helpers for the Outlook sync.
//
// The leading underscore keeps Vercel from treating this as an endpoint.
//
// PERMISSION CHOICE WORTH KNOWING: we ask for Mail.ReadBasic, not Mail.Read.
// ReadBasic returns everything except body, bodyPreview, uniqueBody and
// attachments. So the application is not merely choosing not to store message
// bodies — it is not permitted to read them. That is a far better answer to
// "what can this thing see in my email" than a promise, and it costs nothing,
// because the index only ever wanted headers.

const TENANT = process.env.MS_TENANT_ID;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const REDIRECT_URI = process.env.MS_REDIRECT_URI;

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const SCOPES = 'offline_access openid profile email User.Read Mail.ReadBasic';
export const GRAPH = 'https://graph.microsoft.com/v1.0';

export const authority = () => `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

export function envCheck() {
  const missing = Object.entries({
    MS_TENANT_ID: TENANT, MS_CLIENT_ID: CLIENT_ID, MS_CLIENT_SECRET: CLIENT_SECRET,
    MS_REDIRECT_URI: REDIRECT_URI, SUPABASE_URL: SB, SUPABASE_SERVICE_ROLE_KEY: SB_KEY,
  }).filter(([, v]) => !v).map(([k]) => k);
  return missing.length ? `missing env: ${missing.join(', ')}` : null;
}

/* ------------------------------------------------------------- supabase */

export async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/* --------------------------------------------------------------- tokens */

export async function exchangeCode(code) {
  const r = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${data.error_description || data.error}`);
  return data;
}

// Returns a usable access token, refreshing first if it is close to expiry.
// The 2-minute margin exists because a token that expires mid-request produces
// a 401 that looks like a permissions problem and sends you hunting in Azure.
export async function accessTokenFor(account) {
  const soon = Date.now() + 120_000;
  if (account.access_token && account.token_expires && new Date(account.token_expires).getTime() > soon) {
    return account.access_token;
  }

  const r = await fetch(`${authority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: account.refresh_token,
      scope: SCOPES,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    await sb(`outlook_accounts?id=eq.${account.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ last_error: `refresh failed: ${data.error_description || data.error}` }),
    });
    throw new Error(`refresh ${r.status}: ${data.error_description || data.error}`);
  }

  // Microsoft rotates refresh tokens — store the new one or the connection
  // dies silently days later when the old one is finally rejected.
  await sb(`outlook_accounts?id=eq.${account.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token || account.refresh_token,
      token_expires: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
      last_error: null,
    }),
  });

  return data.access_token;
}

/* ---------------------------------------------------------------- graph */

export async function graph(path, token, init = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`graph ${r.status}: ${text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------ message shaping */

// Mail at these domains is a person, not a company, and counting it would put
// nonsense in the board — "gmail.com: 412 messages" next to real firms.
const PERSONAL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com',
  'mac.com', 'comcast.net', 'sbcglobal.net', 'att.net', 'verizon.net',
  'protonmail.com', 'proton.me', 'gmx.com', 'mail.com', 'zoho.com',
]);

// Internal mail is not outreach. Set OWN_DOMAINS to every domain the company
// sends from, comma separated, or colleagues show up as prospects.
const OWN = new Set(
  String(process.env.OWN_DOMAINS || 'rejournals.com')
    .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
);

// Out-of-office bounces, read receipts and delivery failures are not contact.
// Left uncounted they are actively misleading: an inbound auto-reply looks
// exactly like a human answering, so "ever replied" quietly becomes "has an
// out-of-office". Stored but flagged, so the counts can exclude them while the
// record of what arrived stays intact.
const AUTO_SUBJECT = new RegExp([
  '^\\s*(re:\\s*)?\\[?external\\]?\\s*',          // optional [External] prefix
  '(automatic reply|automatische antwort|auto[- ]?reply|autoreply|autoresponse',
  '|out of (the )?office|undeliverable|delivery status notification',
  '|mail delivery (failed|subsystem)|returned mail|read:|accepted:|declined:',
  '|tentative:|cancelled:|canceled:)',
].join(''), 'i');

export function isAutomatic(msg) {
  return AUTO_SUBJECT.test(String(msg.subject || ''));
}

export function domainOf(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return null;
  const d = String(email).slice(at + 1).toLowerCase().trim();
  return d && d.includes('.') ? d : null;
}

export function isCountable(domain) {
  return !!domain && !PERSONAL.has(domain) && !OWN.has(domain);
}

// One Graph message -> the rows we store. A mail to three people at two firms
// becomes three rows, so per-company counts come out right.
export function rowsFor(msg, account) {
  const auto = isAutomatic(msg);
  const mine = String(account.user_email || '').toLowerCase();
  const from = String(msg.from?.emailAddress?.address || msg.sender?.emailAddress?.address || '').toLowerCase();
  const direction = from === mine ? 'out' : 'in';

  const parties = direction === 'out'
    ? [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]
    : [msg.from || msg.sender].filter(Boolean);

  const seen = new Set();
  const rows = [];

  for (const p of parties) {
    const email = String(p?.emailAddress?.address || '').toLowerCase().trim();
    const domain = domainOf(email);
    if (!email || !isCountable(domain) || seen.has(email)) continue;
    seen.add(email);
    rows.push({
      account_id: account.id,
      graph_id: msg.id,
      internet_message_id: msg.internetMessageId || null,
      direction,
      subject: (msg.subject || '').slice(0, 500),
      sent_at: msg.sentDateTime || msg.receivedDateTime || new Date().toISOString(),
      counterparty_email: email,
      counterparty_domain: domain,
      counterparty_name: (p?.emailAddress?.name || '').slice(0, 200) || null,
      folder: msg.parentFolderId || null,
      is_auto: auto,
      // Deep link into Outlook. Mail.ReadBasic excludes body, previewBody and
      // attachments — webLink is none of those, so it comes through. Opening it
      // requires being signed in as the mailbox owner, so the thread stays
      // gated by Microsoft even when the subject line is visible to the team.
      web_link: msg.webLink || null,
    });
  }
  return rows;
}

export async function storeMessages(rows) {
  if (!rows.length) return 0;
  // on_conflict matches the (graph_id, counterparty_email) unique constraint,
  // so the webhook and the delta catch-up can both deliver the same message
  // without double counting.
  await sb('outlook_messages?on_conflict=graph_id,counterparty_email', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return rows.length;
}

/* --------------------------------------------------------- subscriptions */

// WHY 4230 AND NOT LONGER: Microsoft's documented maximum for mail
// subscriptions has moved over time and I could not re-verify it while writing
// this. 4230 minutes (just under 3 days) is the long-standing conservative
// value and Graph will not reject a request below the cap, whatever the cap
// currently is. We then store the expiry GRAPH RETURNS rather than the one we
// asked for, and the cron renews every few hours — so if the real maximum is
// higher, nothing breaks, we simply renew more often than strictly needed, at
// a cost of one API call. Assuming a number here is the failure mode worth
// avoiding: guess too high and the subscription is silently never created.
export const REQUESTED_MINUTES = 4230;

export async function createSubscription(account, token, baseUrl, clientState) {
  const sub = await graph('/subscriptions', token, {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl: `${baseUrl}/api/outlook/notify`,
      resource: '/me/messages',
      expirationDateTime: new Date(Date.now() + REQUESTED_MINUTES * 60_000).toISOString(),
      clientState,
    }),
  });

  await sb('outlook_subscriptions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{
      account_id: account.id,
      subscription_id: sub.id,
      resource: sub.resource,
      client_state: clientState,
      expires_at: sub.expirationDateTime,   // what Graph said, not what we asked
    }]),
  });

  return sub;
}
