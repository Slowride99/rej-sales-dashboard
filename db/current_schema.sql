-- =====================================================================
-- REJournals Sales Dashboard — live schema
-- Dumped from Supabase 2026-09-04
-- =====================================================================

-- NOTE: ck() does a SINGLE alias lookup and does NOT resolve chains.
-- Every company_aliases.from_key must point DIRECTLY at its final
-- canonical key. Never insert a->b and b->c; write a->c and b->c.
-- Verify with:
--   select count(*) from company_aliases a
--   join company_aliases b on b.from_key = a.to_key;   -- must be 0

-- 1. FUNCTIONS
--    company_key() normalizes names; ck() applies alias overrides
CREATE OR REPLACE FUNCTION public.company_key(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$;
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
$function$;

CREATE OR REPLACE FUNCTION public.ck(raw text)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$;
  select coalesce(a.to_key, company_key(raw))
  from (select company_key(raw) as k) base
  left join company_aliases a on a.from_key = base.k;
$function$;

-- 2. TABLES
--    event_markets, company_aliases, award_entries
create table public.event_markets (
  event_code text not null,
  market text not null,
  constraint event_markets_pkey primary key (event_code),
  constraint event_markets_market_check check (
    (
      market = any (
        array[
          'MN'::text,
          'IL'::text,
          'TX'::text,
          'MI'::text,
          'IN'::text,
          'WI'::text,
          'MO'::text,
          'KY'::text,
          'FL'::text,
          'MT'::text,
          'OH'::text,
          'NE'::text,
          'IA'::text,
          'TN'::text,
          'ND'::text,
          'VIRTUAL'::text,
          'OTHER'::text,
          'EXCLUDE'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;

create table public.company_aliases (
  from_key text not null,
  to_key text not null,
  constraint company_aliases_pkey primary key (from_key)
) TABLESPACE pg_default;

-- NOTE: award_entries is intentionally empty as of this dump.
-- AwardForce history (2023-2026, IL/MN/TX/MI/IN) has not been loaded yet.
-- Zeros in award_entries / award_finalists on company_signals are expected,
-- not a bug. The company_facts union branch is already wired for it.

create table public.award_entries (
  id bigserial not null,
  entry_id text null,
  market text null,
  season_year integer null,
  chapter text null,
  parent text null,
  category text null,
  entry_name text null,
  company_raw text null,
  status text null,
  review_status text null,
  source text null,
  constraint award_entries_pkey primary key (id)
) TABLESPACE pg_default;



-- 3. VIEWS  (events_enriched → company_facts → company_signals)
create or replace view events_enriched as
 SELECT e.code,
    e.event_name,
    e.date,
    EXTRACT(year FROM e.date)::integer AS year,
    e.location,
    e.total_registration_count,
    COALESCE(m.market, 'OTHER'::text) AS market
   FROM events e
     LEFT JOIN event_markets m ON m.event_code = e.code
  WHERE COALESCE(m.market, 'OTHER'::text) <> 'EXCLUDE'::text;

create or replace view company_facts as
 SELECT ck(a.organization) AS key,
    a.organization AS raw_name,
    'attendee'::text AS role,
    ev.market,
    ev.year,
    ev.code AS event_code,
    ev.event_name,
    NULL::text AS tier,
    NULL::text AS detail
   FROM attendees a
     JOIN events_enriched ev ON ev.code = a.event_code
  WHERE ck(a.organization) IS NOT NULL
UNION ALL
 SELECT ck(s.organization) AS key,
    s.organization AS raw_name,
    'speaker'::text AS role,
    ev.market,
    ev.year,
    ev.code AS event_code,
    ev.event_name,
    NULL::text AS tier,
    (s.first_name || ' '::text) || s.last_name AS detail
   FROM speakers s
     JOIN events_enriched ev ON ev.code = s.event_code
  WHERE ck(s.organization) IS NOT NULL
UNION ALL
 SELECT ck(sp.name) AS key,
    sp.name AS raw_name,
    'sponsor'::text AS role,
    ev.market,
    ev.year,
    ev.code AS event_code,
    ev.event_name,
    sp.tiers AS tier,
    sp.website AS detail
   FROM sponsors sp
     JOIN events_enriched ev ON ev.code = sp.event_code
  WHERE ck(sp.name) IS NOT NULL
UNION ALL
 SELECT ck(w.company_raw) AS key,
    w.company_raw AS raw_name,
    'award_entry'::text AS role,
    w.market,
    w.season_year AS year,
    NULL::text AS event_code,
    w.chapter AS event_name,
    w.status AS tier,
    (w.parent || ' / '::text) || COALESCE(w.category, ''::text) AS detail
   FROM award_entries w
  WHERE ck(w.company_raw) IS NOT NULL;

  -- NOTE: sponsors.tiers holds opaque PheedLoop tier IDs
-- (e.g. ["SPTI7MQ9NGNSCR2LAY"]), not readable tier names. The label
-- mapping did not survive the migration. Deliberately not exposed on
-- company_signals. Use times_sponsored / last_sponsored_year instead.

create or replace view company_signals as
 SELECT key,
    market,
    mode() WITHIN GROUP (ORDER BY raw_name) AS display_name,
    count(*) FILTER (WHERE role = 'attendee'::text) AS attendee_count,
    count(DISTINCT event_code) FILTER (WHERE role = 'attendee'::text) AS events_attended,
    count(DISTINCT event_code) FILTER (WHERE role = 'speaker'::text) AS times_spoken,
    count(DISTINCT event_code) FILTER (WHERE role = 'sponsor'::text) AS times_sponsored,
    count(*) FILTER (WHERE role = 'award_entry'::text) AS award_entries,
    count(*) FILTER (WHERE role = 'award_entry'::text AND (lower(tier) = ANY (ARRAY['finalist'::text, 'winner'::text]))) AS award_finalists,
    max(year) FILTER (WHERE role = 'attendee'::text) AS last_attended_year,
    max(year) FILTER (WHERE role = 'speaker'::text) AS last_spoke_year,
    max(year) FILTER (WHERE role = 'sponsor'::text) AS last_sponsored_year,
    max(year) FILTER (WHERE role = 'award_entry'::text) AS last_entry_year,
    max(year) AS last_touch_year,
    min(year) AS first_touch_year,
    count(DISTINCT year) AS active_years,
    (array_agg(detail ORDER BY (length(detail))) FILTER (WHERE role = 'sponsor'::text AND detail IS NOT NULL))[1] AS website
   FROM company_facts
  GROUP BY key, market;

  -- 4. PERMISSIONS
alter table award_entries enable row level security;
revoke all on company_facts, company_signals, events_enriched from anon, authenticated;