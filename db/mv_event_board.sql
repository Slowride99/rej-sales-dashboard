-- ============================================================
--  mv_event_board — the board, materialised
-- ============================================================
--
--  v_event_board recomputes several aggregations over company_facts on
--  every read, which is too slow for a web request (57014 statement
--  timeout). This stores the result and indexes it.
--
--  Requires event_series.sql and v_event_board.sql to have been run.
--
--  REFRESH IT after anything that changes the inputs:
--     - reloading company_domains (new email index)
--     - editing event_series (a renamed series)
--     - new event data landing in company_facts
--
--     refresh materialized view concurrently public.mv_event_board;
--
--  CONCURRENTLY needs the unique index below and does not lock readers.
--  It will not work until the view has been populated once.

drop materialized view if exists public.mv_event_board;

create materialized view public.mv_event_board as
  select * from public.v_event_board;

-- required for REFRESH ... CONCURRENTLY
create unique index if not exists mv_event_board_pk
  on public.mv_event_board (series, key);

-- the access pattern: one series, ordered by email volume
create index if not exists mv_event_board_series_idx
  on public.mv_event_board (series);

create index if not exists mv_event_board_series_emails_idx
  on public.mv_event_board (series, emails desc nulls last);

-- the hero list
create index if not exists mv_event_board_gap_idx
  on public.mv_event_board (series)
  where buys_elsewhere_never_here;

analyze public.mv_event_board;

-- ---------- a cheap series list, so the picker never scans the board ----------
drop materialized view if exists public.mv_event_series_summary;

create materialized view public.mv_event_series_summary as
  select series,
         count(*)                                              as companies,
         count(*) filter (where years_sponsored > 0)           as sponsors,
         count(*) filter (where emails > 0)                    as emailed,
         count(*) filter (where buys_elsewhere_never_here)     as gap,
         min(first_seen)                                       as first_year,
         max(last_seen)                                        as last_year,
         max(market)                                           as market
  from public.mv_event_board
  group by series;

create unique index if not exists mv_event_series_summary_pk
  on public.mv_event_series_summary (series);

analyze public.mv_event_series_summary;

-- ---------- check ----------
select series, companies, sponsors, emailed, gap, first_year, last_year, market
from public.mv_event_series_summary
order by gap desc, sponsors desc
limit 20;
