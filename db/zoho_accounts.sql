-- ============================================================
--  zoho_accounts.sql — Zoho sales history for the Accounts screen
-- ============================================================
--
--  What this adds
--    zoho_accounts        6,979   companies with a sale or an attempt behind them
--    zoho_contacts        9,966   the people attached to those sales
--    zoho_sales          10,848   sales orders, 2018-2026 — the invoiced truth
--    zoho_opportunities  41,492   every opportunity since 2006, won and lost
--    account_work                 stage + follow-up date per account, per office
--    v_account_summary            one row per account per office, with status
--
--  How to run it
--    1. Run SECTION 1 (tables). Safe to re-run.
--    2. Load the four CSVs with the script (it sends real NULLs and can be
--       re-run safely; the Table Editor import can break on empty cells):
--           python3 tools/load_zoho.py
--    3. Run SECTION 2 (link to the dashboard's companies, build the view).
--    4. Run SECTION 3 (checks) and compare with the numbers printed there.
--
--  Nothing here touches company_facts, mv_event_board or any existing table.
--  To undo everything: the DROP block at the very bottom.

-- ============================================================
--  SECTION 1 — tables
-- ============================================================

create table if not exists public.zoho_accounts (
  id               text primary key,          -- Zoho record id, no zcrm_ prefix
  name             text not null,
  website          text,
  phone            text,
  office           text,                      -- Zoho's own Office field; sparse (48%)
  account_type     text,
  industry         text,
  billing_street   text,
  billing_city     text,
  billing_state    text,                      -- normalised to 2 letters where recognisable
  billing_code     text,
  owner            text,
  created_at       timestamptz,
  modified_at      timestamptz,
  last_activity_at timestamptz,
  domain           text,                      -- website host, else commonest contact email domain
  domain_source    text,                      -- 'website' | 'contact email'
  company_key      text                       -- filled in SECTION 2; joins to company_facts
);
create index if not exists zoho_accounts_domain_idx on public.zoho_accounts (domain);
create index if not exists zoho_accounts_key_idx    on public.zoho_accounts (company_key);

create table if not exists public.zoho_contacts (
  id               text primary key,
  account_id       text references public.zoho_accounts(id) on delete set null,
  first_name       text,
  last_name        text,
  full_name        text,
  email            text,
  title            text,
  phone            text,
  mobile           text,
  mailing_city     text,
  mailing_state    text,
  email_opt_out    boolean not null default false,   -- Zoho's do-not-email flag. Respect it.
  lead_source      text,
  linkedin         text,
  owner            text,
  office           text,
  last_activity_at timestamptz
);
create index if not exists zoho_contacts_account_idx on public.zoho_contacts (account_id);
create index if not exists zoho_contacts_email_idx   on public.zoho_contacts (email);

create table if not exists public.zoho_opportunities (
  id               text primary key,
  account_id       text references public.zoho_accounts(id) on delete set null,
  contact_id       text references public.zoho_contacts(id) on delete set null,
  name             text,
  stage            text,                      -- Closed Won / Closed Lost / Prospect / ...
  type             text,                      -- changed meaning in 2020; prefer kind
  opp_types        text,
  product          text,                      -- A.. print, E.. email, NL../D0.. banner, S.. sponsorship
  amount           numeric,
  closing_date     date,
  issue_month      text,                      -- YYYY-MM the ad ran, when recorded
  production_stage text,
  invoice_number   text,
  owner            text,
  created_at       timestamptz,
  modified_at      timestamptz,
  kind             text,                      -- banner | print | email | awards | event | other
  kinds            text                       -- every kind on the line, ';' separated
);
create index if not exists zoho_opps_account_idx on public.zoho_opportunities (account_id);
create index if not exists zoho_opps_closing_idx on public.zoho_opportunities (closing_date);

create table if not exists public.zoho_sales (
  id               text primary key,          -- sales order id
  account_id       text references public.zoho_accounts(id) on delete set null,
  contact_id       text references public.zoho_contacts(id) on delete set null,
  opportunity_id   text references public.zoho_opportunities(id) on delete set null,
  office           text,                      -- Texas | Midwest | Minnesota — which office sold it
  status           text,                      -- 'Invoiced' is the one that counts
  subject          text,
  qb_class         text,                      -- Event/Issue Title (QB Class)
  owner            text,
  created_at       timestamptz,
  due_date         date,
  total            numeric,
  product          text,
  issue_month      text,
  kind             text,
  kinds            text,
  sale_year        int
);
create index if not exists zoho_sales_account_idx on public.zoho_sales (account_id);
create index if not exists zoho_sales_office_idx  on public.zoho_sales (office, status);

-- Who is working an account, where it stands, when to come back to it.
-- Keyed by office as well, because one company can be a Texas ad prospect and
-- a Minnesota event sponsor at the same time, worked by different people.
create table if not exists public.account_work (
  account_id   text not null,
  office       text not null,
  stage        text,                          -- free text on purpose until the team settles its words
  follow_up_on date,
  assigned_to  text,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (account_id, office)
);

-- Same posture as every other table: RLS on, no policies. The API uses the
-- service role key, which bypasses RLS; the anon key can read nothing.
alter table public.zoho_accounts      enable row level security;
alter table public.zoho_contacts      enable row level security;
alter table public.zoho_opportunities enable row level security;
alter table public.zoho_sales         enable row level security;
alter table public.account_work       enable row level security;

-- ============================================================
--  STOP. Run  python3 tools/load_zoho.py  now, then continue.
-- ============================================================


-- ============================================================
--  SECTION 2 — link to the dashboard, build the view
-- ============================================================

-- 2a. Link by domain first: it is the key the dashboard already trusts.
--     company_domains.db_key is the key mv_event_board joins on.
update public.zoho_accounts a
set company_key = d.db_key
from public.company_domains d
where a.company_key is null
  and a.domain is not null
  and lower(d.domain) = a.domain
  and d.db_key is not null and d.db_key <> '';

-- 2b. Then by name, through the same ck() the rest of the pipeline uses, but
--     only where that key really exists in company_facts — an invented key
--     would look linked and join to nothing.
update public.zoho_accounts a
set company_key = k.key
from (
  select z.id, ck(z.name) as key
  from public.zoho_accounts z
  where z.company_key is null
) k
where a.id = k.id
  and k.key is not null
  and exists (select 1 from public.company_facts f where f.key = k.key);
--  If 2a or 2b errors on a column name, check what yours are called:
--      select table_name, column_name from information_schema.columns
--      where table_name in ('company_facts','company_domains') and column_name ilike '%key%';
--  Either one alone is enough to carry on; the screen works with no links at all.

-- 2c. One row per account per office.
--
--  status, by calendar year so it matches how sales talk about it:
--     active       bought a print, email or banner ad this year or last
--     lapsed       last ad 2-4 years back
--     older        last ad further back than that
--     events only  has bought events or awards from this office, never an ad
--
--  Only 'Invoiced' sales orders count. Cancelled and draft orders are history,
--  not custom.
drop view if exists public.v_account_summary;
create view public.v_account_summary as
with s as (
  select *
  from public.zoho_sales
  where status = 'Invoiced' and account_id is not null and office is not null
),
agg as (
  select
    account_id,
    office,
    count(*)                                                    as orders,
    sum(total)                                                  as total,
    min(sale_year)                                              as first_year,
    max(sale_year)                                              as last_year,
    max(created_at)                                             as last_sale_at,
    count(*) filter (where kind in ('print','email','banner'))  as ad_orders,
    sum(total) filter (where kind in ('print','email','banner')) as ad_total,
    max(sale_year) filter (where kind in ('print','email','banner')) as last_ad_year,
    max(created_at) filter (where kind in ('print','email','banner')) as last_ad_at,
    -- which years had an ad, which had only events/awards: drives the year strip
    array_agg(distinct sale_year) filter (where kind in ('print','email','banner')) as ad_years,
    array_agg(distinct sale_year)                               as sale_years,
    bool_or(kinds like '%print%')  as bought_print,
    bool_or(kinds like '%email%')  as bought_email,
    bool_or(kinds like '%banner%') as bought_banner,
    bool_or(kinds like '%event%')  as bought_event,
    bool_or(kinds like '%awards%') as bought_awards
  from s
  group by account_id, office
),
people as (
  select
    account_id,
    count(*)                                                      as contacts,
    count(*) filter (where email is not null and not email_opt_out) as emailable,
    count(*) filter (where email_opt_out)                         as opted_out
  from public.zoho_contacts
  where account_id is not null
  group by account_id
)
select
  a.id            as account_id,
  g.office,
  a.name,
  a.domain,
  a.company_key,
  a.billing_city,
  a.billing_state,
  a.phone,
  a.website,
  g.orders, g.total, g.first_year, g.last_year, g.last_sale_at,
  g.ad_orders, g.ad_total, g.last_ad_year, g.last_ad_at,
  g.ad_years, g.sale_years,
  g.bought_print, g.bought_email, g.bought_banner, g.bought_event, g.bought_awards,
  coalesce(p.contacts, 0)  as contacts,
  coalesce(p.emailable, 0) as emailable,
  coalesce(p.opted_out, 0) as opted_out,
  case
    when g.last_ad_year is null                                         then 'events only'
    when g.last_ad_year >= extract(year from current_date)::int - 1     then 'active'
    when g.last_ad_year >= extract(year from current_date)::int - 4     then 'lapsed'
    else 'older'
  end             as status,
  w.stage, w.follow_up_on, w.assigned_to, w.updated_by as work_updated_by, w.updated_at as work_updated_at
from agg g
join public.zoho_accounts a on a.id = g.account_id
left join people p on p.account_id = a.id
left join public.account_work w on w.account_id = a.id and w.office = g.office;


-- ============================================================
--  SECTION 3 — checks. Read these before trusting the screen.
-- ============================================================

-- 3a. Row counts. Expect 6979 / 9966 / 41492 / 10848.
select 'zoho_accounts' t, count(*) from public.zoho_accounts
union all select 'zoho_contacts', count(*) from public.zoho_contacts
union all select 'zoho_opportunities', count(*) from public.zoho_opportunities
union all select 'zoho_sales', count(*) from public.zoho_sales;

-- 3b. Texas by status. In 2026 expect: active 50, lapsed 127, older 158,
--     events only 280 (615 total). These shift by themselves each January,
--     because 'active' means this year or last.
select status, count(*) from public.v_account_summary
where office = 'Texas' group by status order by 2 desc;

-- 3c. How many accounts joined to a dashboard company. No expected number —
--     this is the first time the two have met. Anything over half is useful;
--     the unlinked ones still work on the Accounts screen, they just have no
--     event history to show.
select
  count(*)                                            as accounts,
  count(*) filter (where company_key is not null)     as linked,
  count(*) filter (where domain is not null)          as have_domain
from public.zoho_accounts
where id in (select account_id from public.v_account_summary where office = 'Texas');

-- 3d. Texas ad buyers by year. Expect 2019:98 2020:144 2021:99 2022:93
--     2023:74 2024:49 2025:39 2026:28.
select sale_year, count(distinct account_id) as ad_accounts, count(*) as ad_orders
from public.zoho_sales
where office = 'Texas' and status = 'Invoiced' and account_id is not null
  and kind in ('print','email','banner')
group by 1 order by 1;


-- ============================================================
--  UNDO — only if you want all of it gone
-- ============================================================
-- drop view  if exists public.v_account_summary;
-- drop table if exists public.account_work;
-- drop table if exists public.zoho_sales;
-- drop table if exists public.zoho_opportunities;
-- drop table if exists public.zoho_contacts;
-- drop table if exists public.zoho_accounts;
