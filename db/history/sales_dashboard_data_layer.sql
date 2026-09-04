-- =====================================================================
-- REJournals Event Sales Dashboard — data layer
--
-- Run once against the Supabase archive. Creates:
--   company_key()        normalizes company names into a join key
--   company_aliases      manual overrides for names the normalizer misses
--   event_markets        maps event_code -> market (MN/IL/TX/MI/IN)
--   events_enriched      events + market + year
--   company_facts        one row per company-per-role-per-event
--   company_signals      one row per company, all history rolled up
--
-- Then four recommendation queries at the bottom.
--
-- Safe to re-run: everything is create-or-replace / if-not-exists.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Company name normalizer
--
-- "Stream Realty Partners" / "Stream Realty, LLC"  -> "stream realty"
-- "CBRE Group Inc." / "CBRE" / "cbre group"        -> "cbre"
--
-- Two deliberate design choices, both learned the hard way:
--
--  a) Only LEGAL suffixes are stripped, and only from the END of the
--     name. Stripping industry words anywhere turns "Lincoln Property
--     Company" into "lincoln" (collides with Lincoln Financial) and
--     "Partners Real Estate" into nothing at all.
--
--  b) Stripping repeats up to 3 times so "Group Inc." and
--     "Realty Partners, LLC" fully unwind.
--
-- chr(160) is the non-breaking space that keeps turning up in AwardForce
-- exports -- same problem as the InDesign merge data.
-- ---------------------------------------------------------------------
create or replace function company_key(raw text)
returns text
language sql
immutable
as $$
  with cleaned as (
    select btrim(regexp_replace(
             regexp_replace(
               lower(replace(coalesce(raw, ''), chr(160), ' ')),
               '[.,&''"/()\-]', ' ', 'g'),
             '\s+', ' ', 'g')) as s
  ),
  -- strip trailing legal-entity tokens, three passes
  p1 as (select btrim(regexp_replace(s, '\y(inc|llc|l l c|ltd|lp|llp|plc|pllc|corp|corporation|co|company|group|holdings|holding)\s*$', '', 'g')) as s from cleaned),
  p2 as (select btrim(regexp_replace(s, '\y(inc|llc|l l c|ltd|lp|llp|plc|pllc|corp|corporation|co|company|group|holdings|holding)\s*$', '', 'g')) as s from p1),
  p3 as (select btrim(regexp_replace(s, '\y(inc|llc|l l c|ltd|lp|llp|plc|pllc|corp|corporation|co|company|group|holdings|holding)\s*$', '', 'g')) as s from p2)
  select nullif(btrim(regexp_replace(s, '\s+', ' ', 'g')), '') from p3;
$$;


-- ---------------------------------------------------------------------
-- 2. Alias overrides
--
-- For the cases the normalizer gets wrong. After the first load, eyeball
-- the top ~200 keys and add rows here for anything that should collapse.
-- Example:
--   insert into company_aliases values ('cushman wakefield','cushman wakefield');
--   insert into company_aliases values ('c b r e','cbre');
-- ---------------------------------------------------------------------
create table if not exists company_aliases (
  from_key text primary key,
  to_key   text not null
);

create or replace function ck(raw text)
returns text
language sql
stable
as $$
  select coalesce(a.to_key, company_key(raw))
  from (select company_key(raw) as k) base
  left join company_aliases a on a.from_key = base.k;
$$;


-- ---------------------------------------------------------------------
-- 3. Event -> market mapping
--
-- The archive has no market/state column: events only carry `location`
-- free text. This table is the fix. Seed it with the guess below, then
-- correct by hand -- it is a one-time job over ~30-50 events and every
-- market filter in the app depends on it being right.
-- ---------------------------------------------------------------------
create table if not exists event_markets (
  event_code text primary key,
  market     text not null check (market in ('MN','IL','TX','MI','IN','OTHER'))
);

-- Seed guess from location text. Review the result before trusting it.
insert into event_markets (event_code, market)
select e.code,
       case
         when e.location ~* '(, ?TX|texas|houston|dallas|austin|san antonio|fort worth)' then 'TX'
         when e.location ~* '(, ?MN|minnesota|minneapolis|saint paul|st\.? paul)'        then 'MN'
         when e.location ~* '(, ?IL|illinois|chicago|rosemont|oak brook)'                then 'IL'
         when e.location ~* '(, ?MI|michigan|detroit|grand rapids)'                      then 'MI'
         when e.location ~* '(, ?IN|indiana|indianapolis)'                               then 'IN'
         else 'OTHER'
       end
from events e
on conflict (event_code) do nothing;

-- Check what the guess could not place:
--   select code, event_name, location from events e
--   join event_markets m on m.event_code = e.code
--   where m.market = 'OTHER';


-- ---------------------------------------------------------------------
-- 4. Events with market and year attached
-- ---------------------------------------------------------------------
create or replace view events_enriched as
select
  e.code,
  e.event_name,
  e.date,
  extract(year from e.date)::int      as year,
  e.location,
  e.total_registration_count,
  coalesce(m.market, 'OTHER')         as market
from events e
left join event_markets m on m.event_code = e.code;


-- ---------------------------------------------------------------------
-- 5. company_facts — one row per company / role / event
--
-- Everything downstream reads this. Adding a new source later (Zoho
-- deals, Fluent Forms ceremony attendance) means adding a union branch
-- here and nothing else changes.
-- ---------------------------------------------------------------------
create or replace view company_facts as
  select ck(a.organization) as key, a.organization as raw_name, 'attendee' as role,
         ev.market, ev.year, ev.code as event_code, ev.event_name,
         null::text as tier, null::text as detail
  from attendees a
  join events_enriched ev on ev.code = a.event_code
  where ck(a.organization) is not null

union all
  select ck(s.organization), s.organization, 'speaker',
         ev.market, ev.year, ev.code, ev.event_name,
         null, s.first_name || ' ' || s.last_name
  from speakers s
  join events_enriched ev on ev.code = s.event_code
  where ck(s.organization) is not null

union all
  select ck(sp.name), sp.name, 'sponsor',
         ev.market, ev.year, ev.code, ev.event_name,
         sp.tiers, sp.website
  from sponsors sp
  join events_enriched ev on ev.code = sp.event_code
  where ck(sp.name) is not null

union all
  select ck(w.company_raw), w.company_raw, 'award_entry',
         w.market, w.season_year, null, w.chapter,
         w.status, w.parent || ' / ' || coalesce(w.category, '')
  from award_entries w
  where ck(w.company_raw) is not null;


-- ---------------------------------------------------------------------
-- 6. company_signals — one row per company, per market
--
-- Per-market rather than global: a firm active in MN tells you nothing
-- about whether to call them for a Texas event.
-- ---------------------------------------------------------------------
create or replace view company_signals as
select
  key,
  market,
  mode() within group (order by raw_name)                                as display_name,

  count(*) filter (where role = 'attendee')                              as attendee_count,
  count(distinct event_code) filter (where role = 'attendee')            as events_attended,
  count(distinct event_code) filter (where role = 'speaker')             as times_spoken,
  count(distinct event_code) filter (where role = 'sponsor')             as times_sponsored,
  count(*) filter (where role = 'award_entry')                           as award_entries,
  count(*) filter (where role = 'award_entry'
                     and lower(tier) in ('finalist','winner'))           as award_finalists,

  max(year) filter (where role = 'attendee')                             as last_attended_year,
  max(year) filter (where role = 'speaker')                              as last_spoke_year,
  max(year) filter (where role = 'sponsor')                              as last_sponsored_year,
  max(year) filter (where role = 'award_entry')                          as last_entry_year,
  max(year)                                                              as last_touch_year,
  min(year)                                                              as first_touch_year,
  count(distinct year)                                                   as active_years,

  max(tier) filter (where role = 'sponsor')                              as last_tier,
  max(detail) filter (where role = 'sponsor')                            as website
from company_facts
group by key, market;


-- =====================================================================
-- RECOMMENDATION QUERIES
--
-- Each returns a score plus a human-readable reason string, so every
-- card on the dashboard can show WHY it is there. Set the two variables
-- at the top of each query for the event you are building.
-- =====================================================================


-- ---------------------------------------------------------------------
-- A. Sponsor prospects for a Texas 2026 event
-- ---------------------------------------------------------------------
with params as (select 'TX'::text as mkt, 2026::int as yr),
scored as (
  select
    s.*,
    -- lapsed sponsor: strongest signal, decayed by how long ago
    case when s.times_sponsored > 0 and s.last_sponsored_year < p.yr
         then greatest(0, 45 - (p.yr - s.last_sponsored_year) * 10) else 0 end
    -- bodies in the room
    + least(20, s.attendee_count * 3)
    -- multiple distinct events, not one big year
    + least(12, s.events_attended * 4)
    -- speaking is engagement without spend
    + case when s.times_spoken > 0 then 15 else 0 end
    -- awards activity: they care about recognition in this market
    + least(15, s.award_entries * 5)
    + case when s.award_finalists > 0 then 8 else 0 end
    -- recency
    + case when s.last_touch_year >= p.yr - 1 then 10
           when s.last_touch_year >= p.yr - 2 then 5 else 0 end
    as score
  from company_signals s cross join params p
  where s.market = p.mkt
)
select
  display_name,
  score,
  website,
  concat_ws(' · ',
    case when times_sponsored > 0
         then 'sponsored ' || times_sponsored || 'x, last ' || last_sponsored_year
         else 'never sponsored' end,
    nullif(attendee_count, 0) || ' attendees across ' || events_attended || ' events',
    case when times_spoken > 0 then 'spoke ' || times_spoken || 'x' end,
    case when award_entries > 0
         then award_entries || ' award entries'
              || case when award_finalists > 0
                      then ' (' || award_finalists || ' finalist/winner)' else '' end end,
    'last touch ' || last_touch_year
  ) as reason
from scored
where score > 0
  -- exclude anyone already committed for the target year
  and key not in (
    select ck(sp.name) from sponsors sp
    join events_enriched ev on ev.code = sp.event_code
    cross join params p
    where ev.market = p.mkt and ev.year = p.yr
  )
order by score desc, attendee_count desc
limit 40;


-- ---------------------------------------------------------------------
-- B. Speaker prospects — people, not companies
--
-- Prior speakers first, then senior titles from companies already
-- engaged in the market. Headshots come along for the card.
-- ---------------------------------------------------------------------
with params as (select 'TX'::text as mkt, 2026::int as yr)
select
  sp.first_name || ' ' || sp.last_name        as name,
  sp.title,
  sp.organization,
  sp.picture                                  as headshot,
  sp.email,
  count(distinct sp.event_code)               as times_spoken,
  max(ev.year)                                as last_spoke,
  max(cs.times_sponsored)                     as company_sponsorships,
  max(cs.award_entries)                       as company_award_entries,
  ( least(30, count(distinct sp.event_code) * 15)
    + case when max(ev.year) >= 2025 then 20 else 10 end
    + case when max(cs.times_sponsored) > 0 then 20 else 0 end
    + least(15, max(cs.award_entries) * 5)
    + case when sp.picture is not null then 5 else 0 end
  )                                           as score
from speakers sp
join events_enriched ev on ev.code = sp.event_code
cross join params p
left join company_signals cs
       on cs.key = ck(sp.organization) and cs.market = p.mkt
where ev.market = p.mkt
group by sp.first_name, sp.last_name, sp.title, sp.organization, sp.picture, sp.email
order by score desc
limit 40;


-- ---------------------------------------------------------------------
-- C. Gap lists — the four Jeff will actually recognize
-- ---------------------------------------------------------------------

-- C1. Lapsed sponsors: paid before, absent now
select display_name, times_sponsored, last_sponsored_year, last_tier,
       attendee_count, last_touch_year
from company_signals
where market = 'TX' and times_sponsored > 0 and last_sponsored_year < 2026
order by last_sponsored_year desc, times_sponsored desc;

-- C2. Heavy attendance, never sponsored
select display_name, attendee_count, events_attended, active_years, last_attended_year
from company_signals
where market = 'TX' and times_sponsored = 0 and attendee_count >= 3
order by attendee_count desc;

-- C3. Award entrants who have never attended an event
select display_name, award_entries, award_finalists, last_entry_year
from company_signals
where market = 'TX' and award_entries > 0 and events_attended = 0
order by award_finalists desc, award_entries desc;

-- C4. Event regulars who have never entered awards
select display_name, events_attended, attendee_count, times_sponsored, last_attended_year
from company_signals
where market = 'TX' and award_entries = 0 and events_attended >= 2
order by events_attended desc, attendee_count desc;


-- ---------------------------------------------------------------------
-- D. Normalizer QA — run BOTH of these after every load
-- ---------------------------------------------------------------------

-- D1. MERGES: keys that collapsed several spellings.
-- Scan these to confirm the merges are correct. A wrong merge means two
-- different firms got fused -- fix by making the name more specific at
-- source, since aliases can only join keys, never split them.
select key,
       count(distinct raw_name)             as spellings,
       string_agg(distinct raw_name, ' | ')  as variants
from company_facts
group by key
having count(distinct raw_name) > 1
order by spellings desc, key
limit 50;

-- D2. SPLITS: one key is a prefix of another -- almost always the same
-- firm recorded long in one source and short in another
-- ("Hines" vs "Hines Interests"). These are INVISIBLE in D1 because the
-- keys differ, and they are the failure that shows the same company
-- twice on a dashboard. Each real match becomes a company_aliases row.
with keys as (
  select distinct key, market from company_facts where key is not null
)
select
  a.key                      as short_key,
  b.key                      as long_key,
  a.market,
  'insert into company_aliases values (' ||
    quote_literal(b.key) || ', ' || quote_literal(a.key) || ');' as fix_sql
from keys a
join keys b
  on b.key <> a.key
 and b.key like a.key || ' %'
 and b.market = a.market
order by a.key;

-- Paste the fix_sql lines you agree with, then re-run the views.
-- Aliases apply through ck(), so nothing else needs changing.
