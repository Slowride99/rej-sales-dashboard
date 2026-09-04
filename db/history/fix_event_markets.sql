-- =====================================================================
-- event_markets — CORRECTED mapping
--
-- Fixes three bugs found against real data:
--   1. ", Milwaukee, WI" matched the pattern ", ?MI" and was labelled
--      Michigan. State codes now require word boundaries.
--   2. Many MN events carry the state only in event_name ("Summit
--      Minnesota 2021", "MN 2022") with a bare venue in location.
--      Matching now reads event_name AND location together.
--   3. Test/junk events ("AlaN test1", "DO NOT USE") were being counted
--      as real. They now map to EXCLUDE and are filtered out.
--
-- Run this AFTER the data layer script. It replaces the seeded guess.
-- =====================================================================

-- widen the allowed markets: the archive spans more than five states
alter table event_markets drop constraint if exists event_markets_market_check;
alter table event_markets add constraint event_markets_market_check
  check (market in ('MN','IL','TX','MI','IN','WI','MO','KY','FL','MT','OTHER','EXCLUDE'));

-- re-derive every row from event_name + location together
update event_markets m
set market = v.guess
from (
  select e.code,
         case
           -- test / junk first, so it wins over any venue match
           when e.event_name ~* '(^|\W)(test|do not use|ignore this)(\W|$)' then 'EXCLUDE'

           when blob ~* '(\yTX\y|texas|houston|dallas|austin|san antonio|fort worth|briar club)'      then 'TX'
           when blob ~* '(\yMN\y|minnesota|minneapolis|saint paul|st\.? paul|rochester|st\.? cloud|bloomington|golden valley|mendota)' then 'MN'
           when blob ~* '(\yIL\y|illinois|chicago|rosemont|oak brook|lombard|chicagoland)'            then 'IL'
           when blob ~* '(\yMI\y|michigan|detroit|birmingham|southfield|troy)'                        then 'MI'
           when blob ~* '(\yIN\y|indiana|indianapolis)'                                               then 'IN'
           when blob ~* '(\yWI\y|wisconsin|milwaukee)'                                                then 'WI'
           when blob ~* '(\yMO\y|missouri|kansas city|st\.? louis)'                                   then 'MO'
           when blob ~* '(\yKY\y|kentucky|louisville)'                                                then 'KY'
           when blob ~* '(\yFL\y|florida|miami|coral gables)'                                         then 'FL'
           when blob ~* '(\yMT\y|montana|bozeman)'                                                    then 'MT'
           else 'OTHER'
         end as guess
  from (
    select code, event_name,
           coalesce(event_name,'') || ' ~ ' || coalesce(location,'') as blob
    from events
  ) e
) v
where v.code = m.code;

-- catch any events missing from the mapping table entirely
insert into event_markets (event_code, market)
select e.code, 'OTHER' from events e
where not exists (select 1 from event_markets m where m.event_code = e.code)
on conflict (event_code) do nothing;


-- ---------------------------------------------------------------------
-- Review: counts by market
-- ---------------------------------------------------------------------
select m.market, count(*) as events,
       min(e.date) as earliest, max(e.date) as latest
from event_markets m
join events e on e.code = m.event_code
group by m.market
order by count(*) desc;

-- ---------------------------------------------------------------------
-- Review: anything still unplaced -- fix these by hand
-- ---------------------------------------------------------------------
select e.code, e.event_name, e.location, e.date
from events e
join event_markets m on m.event_code = e.code
where m.market = 'OTHER'
order by e.date;

-- ---------------------------------------------------------------------
-- Review: what got excluded as test data -- confirm none are real
-- ---------------------------------------------------------------------
select e.code, e.event_name, e.date, e.total_registration_count
from events e
join event_markets m on m.event_code = e.code
where m.market = 'EXCLUDE'
order by e.event_name;

-- Manual fix pattern:
--   update event_markets set market = 'TX' where event_code = 'EVENBLERZLPSF';


-- ---------------------------------------------------------------------
-- Keep EXCLUDE out of every downstream view.
-- Re-run this after the update above.
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
left join event_markets m on m.event_code = e.code
where coalesce(m.market, 'OTHER') <> 'EXCLUDE';
