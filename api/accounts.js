// api/accounts.js — the Accounts screen: who buys ads, who used to, who to call.
//
//   GET  /api/accounts?office=Texas
//        -> { office, offices, counts, due, accounts:[...] }
//   GET  /api/accounts?office=Texas&id=<account_id>
//        -> { account, contacts, sales, lost, mine }
//   POST /api/accounts { account_id, office, stage, follow_up_on }
//        -> { ok, work }
//
// Reads v_account_summary (db/zoho_accounts.sql). Status is computed in the
// view, not here, so the screen and any SQL you run by hand always agree.
//
// Notes are NOT handled here. They use the existing /api/board-notes with
//   series = 'accounts:<office>'   key = 'zoho:<account_id>'
// so there is one notes store, one authorship rule, one place to fix.
//
// Env (server-side only — no VITE_ prefix):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { requireSession } from './_session.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OFFICES = ['Texas', 'Midwest', 'Minnesota'];
const STATUSES = ['active', 'lapsed', 'older', 'events only'];

async function sb(path, init = {}) {
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

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const enc = encodeURIComponent;
const isId = (s) => /^[0-9]{6,30}$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export default async function handler(req, res) {
  const me = requireSession(req, res);
  if (!me) return;

  if (!SB || !SB_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  }

  try {
    /* ----------------------------------------------------------- write ---- */
    if (req.method === 'POST') {
      const { account_id, office, stage, follow_up_on } = await readBody(req);
      if (!isId(account_id) || !OFFICES.includes(office)) {
        return res.status(400).json({ error: 'account_id and a known office are required' });
      }
      const cleanStage = typeof stage === 'string' ? stage.trim().slice(0, 60) : '';
      const cleanDate = isDate(follow_up_on) ? follow_up_on : null;

      // Nothing left to remember -> remove the row, same rule as notes.
      if (!cleanStage && !cleanDate) {
        await sb(`account_work?account_id=eq.${enc(account_id)}&office=eq.${enc(office)}`, { method: 'DELETE' });
        return res.json({ ok: true, work: null });
      }

      const saved = await sb('account_work?on_conflict=account_id,office', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          account_id, office,
          stage: cleanStage || null,
          follow_up_on: cleanDate,
          updated_by: me.email,
          updated_at: new Date().toISOString(),
        }]),
      });
      return res.json({ ok: true, work: saved?.[0] || null });
    }

    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'GET or POST' });
    }

    const office = OFFICES.includes(req.query.office) ? req.query.office : 'Texas';

    /* ------------------------------------------------------ one account ---- */
    if (req.query.id) {
      const id = String(req.query.id);
      if (!isId(id)) return res.status(400).json({ error: 'bad id' });

      const [summary, contacts, sales, lost] = await Promise.all([
        sb(`v_account_summary?account_id=eq.${id}&select=*`),
        sb(`zoho_contacts?account_id=eq.${id}` +
           '&select=id,full_name,title,email,phone,mobile,email_opt_out,linkedin,mailing_city,mailing_state,last_activity_at' +
           '&order=last_activity_at.desc.nullslast&limit=60'),
        sb(`zoho_sales?account_id=eq.${id}` +
           '&select=id,office,status,subject,qb_class,product,kind,kinds,total,created_at,sale_year,issue_month,owner,contact_id' +
           '&order=created_at.desc&limit=300'),
        // What was pitched and did not close: the context a cold call lacks.
        sb(`zoho_opportunities?account_id=eq.${id}&stage=neq.Closed%20Won` +
           '&select=id,name,stage,product,kind,amount,closing_date,owner' +
           '&order=closing_date.desc.nullslast&limit=25'),
      ]);

      if (!summary.length) {
        // Known to Zoho but never invoiced by any office.
        const bare = await sb(`zoho_accounts?id=eq.${id}&select=id,name,domain,company_key,billing_city,billing_state,phone,website`);
        if (!bare.length) return res.status(404).json({ error: 'no such account' });
        return res.json({ account: { ...bare[0], account_id: id, office, status: 'no sales' }, offices: [], contacts, sales, lost });
      }

      const mine = summary.find((s) => s.office === office) || summary[0];
      return res.json({
        account: mine,
        // The same company seen from the other offices — so Texas can see that
        // Minnesota sells them events, without anyone opening Zoho.
        offices: summary.map((s) => ({
          office: s.office, status: s.status, orders: s.orders, total: s.total,
          last_year: s.last_year, last_ad_year: s.last_ad_year,
        })),
        contacts, sales, lost,
      });
    }

    /* ------------------------------------------------------------ list ---- */
    const rows = await sb(
      `v_account_summary?office=eq.${enc(office)}` +
      '&select=account_id,name,domain,company_key,billing_city,billing_state,' +
      'orders,total,first_year,last_year,last_sale_at,ad_orders,ad_total,last_ad_year,last_ad_at,' +
      'ad_years,sale_years,bought_print,bought_email,bought_banner,bought_event,bought_awards,' +
      'contacts,emailable,opted_out,status,stage,follow_up_on,work_updated_by' +
      '&order=last_ad_at.desc.nullslast,last_sale_at.desc&limit=5000'
    );

    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;

    const today = new Date().toISOString().slice(0, 10);
    const due = rows
      .filter((r) => r.follow_up_on && r.follow_up_on <= today)
      .sort((a, b) => a.follow_up_on.localeCompare(b.follow_up_on))
      .map((r) => r.account_id);

    const years = rows.flatMap((r) => r.sale_years || []);
    return res.json({
      office,
      offices: OFFICES,
      counts,
      total: rows.length,
      years: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
      due,
      me: me.email,
      accounts: rows,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
