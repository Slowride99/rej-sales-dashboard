/* eslint-env node */
// api/mail.js
// Email history with one company, read from the INDEX rather than live Graph.
//
//   GET /api/mail?status=1              -> { connected, user }
//   GET /api/mail?q=Pace%20Group        -> by company name
//   GET /api/mail?key=pace%20loan       -> by company key (preferred — exact)
//   GET /api/mail?domain=paceloan.com   -> by domain
//   GET /api/mail?series=<name>         -> latest mail with ANY company on
//                                          that event's board — the activity
//                                          feed, scoped so unrelated mail from
//                                          the mailbox never appears
//
// WHAT CHANGED AND WHY
//
// The previous version read ms_token from a cookie set by api/auth/callback
// and ran a live Graph $search per panel open. That is gone because:
//
//   * the cookie flow is retired — tokens now live in outlook_accounts
//   * a live $search only sees the server mailbox, so it misses everything
//     Jeff filed into Personal.pst, which is most of the history
//   * it cost a Graph round-trip on every panel open
//
// Reading outlook_messages is faster, shows the same mail to everyone on the
// team instead of only to whoever is signed in, and will cover the whole
// archive once the .pst extract is loaded into this table.
//
// NO BODIES. The index stores headers only, and Mail.ReadBasic does not permit
// reading bodies at all — so bodyPreview is gone from the response. The panel
// shows who, when, which way, the subject line, and a webLink that opens the
// real thread in Outlook for whoever owns that mailbox.
//
// SCOPE TODAY: outlook_messages only holds mail that has arrived since the
// Graph sync started. Until the 3-year extract is loaded into this same table,
// older history will not appear here even though its COUNTS do show on the
// board (those come from company_domains). That gap is visible in the response
// as `covers_from`, so the UI can say so rather than implying there was no
// contact.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const clean = (s) => String(s || '').replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** Every domain belonging to a company on this event's board.
 *  Scoping matters: without it an "activity feed" would show whatever happened
 *  to be newest in the mailbox, including mail that has nothing to do with the
 *  event or with sponsorship at all. */
async function domainsForSeries(series) {
  const rows = await sb(
    `mv_event_board?series=eq.${encodeURIComponent(series)}&select=domains&limit=500`
  );
  const out = new Set();
  for (const r of rows) {
    for (const d of String(r.domains || '').split(',')) {
      const t = d.trim().toLowerCase();
      if (t) out.add(t);
    }
  }
  return [...out];
}

/** Which domains belong to this company. */
async function domainsFor({ domain, key, q }) {
  if (domain) return [String(domain).toLowerCase().trim()];

  if (key) {
    const rows = await sb(
      `company_domains?db_key=eq.${encodeURIComponent(key)}&select=domain&limit=25`
    );
    return rows.map((r) => r.domain).filter(Boolean);
  }

  if (q) {
    const rows = await sb(
      `company_domains?company_name=ilike.${encodeURIComponent(`*${clean(q)}*`)}&select=domain&limit=25`
    );
    return rows.map((r) => r.domain).filter(Boolean);
  }

  return [];
}

export default async function handler(req, res) {
  if (!SB || !SB_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  try {
    // "Connected" now means a mailbox is syncing, not that this browser holds
    // a token. Anyone on the team sees the same history.
    const accounts = await sb('outlook_accounts?select=user_email,last_sync_at&limit=10');
    const connected = accounts.length > 0;
    const user = accounts.map((a) => a.user_email).join(', ');

    if (req.query.status || !connected) {
      return res.status(200).json({ connected, user, messages: [] });
    }

    const domains = req.query.series
      ? await domainsForSeries(req.query.series)
      : await domainsFor({
          domain: req.query.domain,
          key: req.query.key,
          q: req.query.q,
        });

    if (!domains.length) {
      return res.status(200).json({
        connected, user, messages: [],
        note: 'no email domain on file for this company yet',
      });
    }

    const top = Math.min(Number(req.query.top) || 12, 50);
    const list = domains.map(encodeURIComponent).join(',');

    const rows = await sb(
      `outlook_messages?counterparty_domain=in.(${list})` +
      // Auto-replies are stored but never shown — an out-of-office in a
      // contact list reads as a conversation that did not happen.
      '&is_auto=not.is.true' +
      '&select=subject,direction,sent_at,counterparty_email,counterparty_name,web_link' +
      `&order=sent_at.desc&limit=${top}`
    );

    // Earliest message we hold, so the UI can be honest about coverage rather
    // than letting an empty list read as "we never contacted them".
    const [earliest] = await sb(
      'outlook_messages?select=sent_at&order=sent_at.asc&limit=1'
    );

    // For the feed, each row needs a company name — the panel is showing mail
    // across many companies, so the counterparty domain alone is not enough.
    let nameByDomain = {};
    if (req.query.series) {
      const seen = [...new Set(rows.map((r) => r.counterparty_domain))];
      if (seen.length) {
        const named = await sb(
          `company_domains?domain=in.(${seen.map(encodeURIComponent).join(',')})` +
          '&select=domain,company_name'
        );
        nameByDomain = Object.fromEntries(named.map((r) => [r.domain, r.company_name]));
      }
    }

    const messages = rows.map((m) => ({
      subject: m.subject || '(no subject)',
      direction: m.direction,                       // 'out' = we sent it
      from: m.direction === 'out' ? user : (m.counterparty_name || m.counterparty_email),
      fromAddress: m.direction === 'out' ? user : m.counterparty_email,
      to: m.direction === 'out' ? (m.counterparty_name || m.counterparty_email) : user,
      date: m.sent_at,
      domain: m.counterparty_domain,
      company: nameByDomain[m.counterparty_domain] || m.counterparty_domain,
      preview: '',            // headers only — Mail.ReadBasic cannot read bodies
      // Opens the real thread in Outlook. Only works for the mailbox owner —
      // anyone else gets a permission error from Microsoft, which is the
      // behaviour we want.
      link: m.web_link || '',
    }));

    return res.status(200).json({
      connected,
      user,
      query: req.query.key || req.query.domain || req.query.q || '',
      domains,
      covers_from: earliest?.sent_at || null,
      messages,
    });
  } catch (err) {
    console.error('mail error:', err);
    return res.status(500).json({ error: err.message || 'Mail lookup failed' });
  }
}
