-- ============================================================
--  event_notes — what Jeff types
-- ============================================================
--
--  Deliberately its own table, keyed by (series, company_key) as TEXT with no
--  foreign key into company_facts. Reasons:
--
--    * the board is a materialised view — refreshing it would break an FK
--    * a company key can change when the match pipeline re-runs; a note
--      pointing at a key that no longer exists is harmless, where a cascading
--      delete would silently destroy Jeff's typing
--    * notes are the one thing here that cannot be regenerated from source
--
--  So: nothing in the ETL ever writes to or deletes from this table.

create table if not exists public.event_notes (
  series       text        not null,
  company_key  text        not null,
  body         text        not null,
  updated_at   timestamptz not null default now(),
  primary key (series, company_key)
);

-- the read pattern: every note for one series, in one go
create index if not exists event_notes_series_idx
  on public.event_notes (series);

-- The API talks to Supabase with the service role, which bypasses RLS.
-- RLS on with no policy means an anon/browser key gets nothing, so a leaked
-- VITE_ key can't read Jeff's notes.
alter table public.event_notes enable row level security;

-- ---------- check ----------
select count(*) as notes, count(distinct series) as series
from public.event_notes;
