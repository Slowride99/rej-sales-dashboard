-- ============================================================
--  v_event_board — one row per company per event series
-- ============================================================
--
--  This is the Sponsors screen. Everything on it comes from here:
--  who turns up, who speaks, who sponsors, who we email, and whether
--  they buy from us somewhere else.
--
--  Requires event_series.sql to have been run first.
--
--  Use:
--    select * from v_event_board
--    where series = 'REDnews DFW Industrial Real Estate Summit'
--    order by emails desc nulls last;

create or replace view public.v_event_board as
with facts as (
  select es.series, cf.key, cf.year, cf.role, cf.market
  from public.company_facts cf
  join public.event_series es using (event_code)
),
involved as (
  select series, key,
         count(*) filter (where role = 'attendee')               as attendees,
         count(distinct year) filter (where role = 'attendee')   as years_attended,
         count(*) filter (where role = 'speaker')                as spoke,
         count(distinct year) filter (where role = 'sponsor')    as years_sponsored,
         max(year) filter (where role = 'sponsor')               as last_sponsored_here,
         min(year)                                               as first_seen,
         max(year)                                               as last_seen,
         array_agg(distinct year order by year)
           filter (where role = 'sponsor')                       as sponsor_years,
         max(market)                                             as market
  from facts
  group by series, key
),
mail as (
  -- rolled up per company: a company can hold several domains
  select db_key                            as key,
         sum(messages)::int                as emails,
         sum(coalesce(nullif(sent_to,'')::int, 0))::int as emails_sent,
         max(last_date)                    as last_emailed,
         bool_or(replied = 'y')            as ever_replied,
         string_agg(distinct domain, ', ') as domains
  from public.company_domains
  where db_key is not null and db_key <> ''
  group by db_key
),
elsewhere as (
  select key,
         sum(times_sponsored)                                      as sponsorships_total,
         count(distinct market) filter (where times_sponsored > 0) as markets_sponsored,
         max(last_sponsored_year)                                  as last_sponsored_anywhere
  from public.company_signals
  group by key
)
select
  i.series,
  i.key,
  coalesce(sig.display_name, initcap(i.key))      as company,
  i.market,

  -- this event
  i.sponsor_years,
  i.years_sponsored,
  i.last_sponsored_here,
  i.attendees,
  i.years_attended,
  i.spoke,
  i.first_seen,
  i.last_seen,

  -- their relationship with us overall
  coalesce(e.sponsorships_total, 0)               as sponsorships_total,
  coalesce(e.markets_sponsored, 0)                as markets_sponsored,
  e.last_sponsored_anywhere,

  -- what we've sent them
  m.emails,
  m.emails_sent,
  m.last_emailed,
  m.ever_replied,
  m.domains,

  -- the headline: buys from us elsewhere, never here, and we keep emailing
  (i.years_sponsored = 0
     and coalesce(e.sponsorships_total, 0) > 0
     and coalesce(m.emails, 0) > 0)               as buys_elsewhere_never_here

from involved i
left join mail m       on m.key = i.key
left join elsewhere e  on e.key = i.key
left join public.company_signals sig
       on sig.key = i.key and sig.market = i.market;

comment on view public.v_event_board is
  'One row per company per event series: attendance, speaking, sponsorship, email activity, and whether they sponsor us in other markets but never this one.';
