-- =====================================================================
-- prospect scoring functions
--
--   sponsor_prospects(market, year, limit)  -> ranked companies
--   speaker_prospects(market, limit)        -> ranked people
--
-- Both return a score AND a plain-English reason built from the same
-- numbers, so every card on the dashboard can show why it is there.
-- Scores are deliberately simple arithmetic on visible columns -- when
-- someone asks "why is this one at the top", you can point at the row.
--
-- Run in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Sponsor prospects
--
-- Scoring, all additive:
--   lapsed sponsor      up to 45, decaying 10/year since last sponsorship
--   attendance volume   up to 20  (3 per attendee)
--   event spread        up to 12  (4 per distinct event)
--   has spoken             +15    (engaged without ever paying)
--   award entries       up to 15  (5 each)
--   award finalist         +8
--   recency                +10 this year or last, +5 two years back
--   tenure              up to  8  (2 per active year)
--
-- Companies already committed for the target year are excluded.
-- ---------------------------------------------------------------------
create or replace function sponsor_prospects(
  p_market text default 'TX',
  p_year   int  default extract(year from current_date)::int,
  p_limit  int  default 50
)
returns table (
  key                  text,
  display_name         text,
  score                int,
  reason               text,
  website              text,
  attendee_count       bigint,
  events_attended      bigint,
  times_spoken         bigint,
  times_sponsored      bigint,
  award_entries        bigint,
  last_sponsored_year  int,
  last_touch_year      int,
  active_years         bigint,
  is_lapsed            boolean
)
language sql
stable
as $$
  with scored as (
    select
      s.*,
      (
        case when s.times_sponsored > 0 and s.last_sponsored_year < p_year
             then greatest(0, 45 - (p_year - s.last_sponsored_year) * 10)
             else 0 end
        + least(20, s.attendee_count * 3)
        + least(12, s.events_attended * 4)
        + case when s.times_spoken > 0 then 15 else 0 end
        + least(15, s.award_entries * 5)
        + case when s.award_finalists > 0 then 8 else 0 end
        + case when s.last_touch_year >= p_year - 1 then 10
               when s.last_touch_year >= p_year - 2 then 5
               else 0 end
        + least(8, s.active_years * 2)
      )::int as score
    from company_signals s
    where s.market = p_market
      and s.key <> '__internal__'
      -- drop anyone already signed for the target year
      and s.key not in (
        select ck(sp.name)
        from sponsors sp
        join events_enriched ev on ev.code = sp.event_code
        where ev.market = p_market
          and ev.year = p_year
          and ck(sp.name) is not null
      )
  )
  select
    sc.key,
    sc.display_name,
    sc.score,
    concat_ws(' · ',
      case
        when sc.times_sponsored > 0
          then 'sponsored ' || sc.times_sponsored || 'x, last in ' || sc.last_sponsored_year
        else 'never sponsored'
      end,
      case
        when sc.attendee_count > 0
          then sc.attendee_count || ' attendee'  || case when sc.attendee_count  = 1 then '' else 's' end
               || ' across ' ||
               sc.events_attended || ' event' || case when sc.events_attended = 1 then '' else 's' end
      end,
      case when sc.times_spoken > 0
           then 'spoke at ' || sc.times_spoken || ' event' || case when sc.times_spoken = 1 then '' else 's' end end,
      case
        when sc.award_entries > 0
          then sc.award_entries || ' award entr' || case when sc.award_entries = 1 then 'y' else 'ies' end
               || case when sc.award_finalists > 0
                       then ' (' || sc.award_finalists || ' finalist/winner)'
                       else '' end
      end,
      'active in ' || sc.active_years || ' of the last 5 years',
      'last contact ' || sc.last_touch_year
    ) as reason,
    sc.website,
    sc.attendee_count,
    sc.events_attended,
    sc.times_spoken,
    sc.times_sponsored,
    sc.award_entries,
    sc.last_sponsored_year,
    sc.last_touch_year,
    sc.active_years,
    (sc.times_sponsored > 0 and sc.last_sponsored_year < p_year) as is_lapsed
  from scored sc
  where sc.score > 0
  order by sc.score desc, sc.attendee_count desc
  limit p_limit;
$$;


-- ---------------------------------------------------------------------
-- Speaker prospects — people, not companies
--
-- Prior speakers rank first, boosted when their company is also
-- commercially engaged. Headshots come through for the card.
-- ---------------------------------------------------------------------
create or replace function speaker_prospects(
  p_market text default 'TX',
  p_limit  int  default 50
)
returns table (
  name                  text,
  title                 text,
  organization          text,
  headshot              text,
  email                 text,
  score                 int,
  reason                text,
  times_spoken          bigint,
  last_spoke_year       int,
  company_sponsorships  bigint,
  company_attendees     bigint
)
language sql
stable
as $$
  with people as (
    select
      (sp.first_name || ' ' || sp.last_name)          as name,
      max(sp.title)                                   as title,
      max(sp.organization)                            as organization,
      max(sp.picture)                                 as headshot,
      max(sp.email)                                   as email,
      count(distinct sp.event_code)                   as times_spoken,
      max(ev.year)                                    as last_spoke_year,
      ck(max(sp.organization))                        as company_key
    from speakers sp
    join events_enriched ev on ev.code = sp.event_code
    where ev.market = p_market
      and sp.first_name is not null
    group by sp.first_name, sp.last_name
  ),
  joined as (
    select
      p.*,
      coalesce(cs.times_sponsored, 0) as company_sponsorships,
      coalesce(cs.attendee_count, 0)  as company_attendees
    from people p
    left join company_signals cs
           on cs.key = p.company_key and cs.market = p_market
  )
  select
    j.name,
    j.title,
    j.organization,
    j.headshot,
    j.email,
    (
      least(30, j.times_spoken * 15)
      + case when j.last_spoke_year >= extract(year from current_date)::int - 1 then 20
             when j.last_spoke_year >= extract(year from current_date)::int - 3 then 12
             else 4 end
      + case when j.company_sponsorships > 0 then 20 else 0 end
      + least(12, j.company_attendees)
      + case when j.headshot is not null then 5 else 0 end
    )::int as score,
    concat_ws(' · ',
      'spoke at ' || j.times_spoken || ' event' || case when j.times_spoken = 1 then '' else 's' end,
      'last in ' || j.last_spoke_year,
      case when j.company_sponsorships > 0
           then 'company sponsored ' || j.company_sponsorships || 'x' end,
      case when j.company_attendees > 0
           then 'company sent ' || j.company_attendees || ' attendees' end
    ) as reason,
    j.times_spoken,
    j.last_spoke_year,
    j.company_sponsorships,
    j.company_attendees
  from joined j
  order by score desc, j.times_spoken desc
  limit p_limit;
$$;


-- ---------------------------------------------------------------------
-- Keep these server-side only, like the views.
-- ---------------------------------------------------------------------
revoke all on function sponsor_prospects(text, int, int) from anon, authenticated;
revoke all on function speaker_prospects(text, int)      from anon, authenticated;


-- ---------------------------------------------------------------------
-- Try them:
--   select display_name, score, reason from sponsor_prospects('TX', 2026, 20);
--   select name, organization, score, reason from speaker_prospects('TX', 20);
-- ---------------------------------------------------------------------
