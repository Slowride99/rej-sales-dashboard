-- ============================================================
--  event_series — group event instances into the series they belong to
-- ============================================================
--
--  Why this exists: events get renamed. "4th Annual REDnews North Texas
--  Industrial Summit" (2023) and "REDnews DFW Industrial Real Estate
--  Summit (6th Annual)" (2025) are the same event. Any report that groups
--  by name splits it in two, and both halves look plausible, so nobody
--  notices. This table makes the grouping explicit and correctable.
--
--  Run this whole file once. Then check the review query at the bottom
--  and fix anything that landed in the wrong series.

create table if not exists public.event_series (
  event_code  text primary key,
  series      text not null,
  note        text
);

-- ---------- 1. seed from the event names, with the ordinal stripped ----------
insert into public.event_series (event_code, series)
select distinct
  event_code,
  trim(regexp_replace(
    regexp_replace(
      regexp_replace(event_name, '\(?\y\d+(st|nd|rd|th)\s+Annual\)?', '', 'gi'),
      '^\s*\d{4}\s+', '', 'g'),
    '\s+', ' ', 'g'))
from public.company_facts
where event_code is not null
on conflict (event_code) do nothing;

-- ---------- 2. known renames ----------
-- DFW Industrial was called North Texas Industrial through 2024.
update public.event_series es
set    series = 'REDnews DFW Industrial Real Estate Summit',
       note   = 'renamed from North Texas Industrial after 2024'
from   public.company_facts cf
where  cf.event_code = es.event_code
and    cf.market = 'TX'
and    cf.event_name ilike '%industrial%'
and    (cf.event_name ilike '%north texas%' or cf.event_name ilike '%dfw%');

-- Add further renames here as you find them, same shape.

-- ---------- 3. review: series spanning multiple years ----------
-- Run this and eyeball it. Anything that should be one series but shows up
-- as two needs a rule in section 2.
select es.series,
       count(distinct cf.year)                             as years,
       min(cf.year) || '-' || max(cf.year)                 as span,
       count(*) filter (where cf.role = 'sponsor')         as sponsor_rows,
       count(distinct cf.key) filter (where cf.role='sponsor') as sponsor_cos,
       string_agg(distinct cf.market, ',')                 as markets
from public.event_series es
join public.company_facts cf using (event_code)
group by es.series
having count(distinct cf.year) >= 2
order by sponsor_rows desc
limit 40;
