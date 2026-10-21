-- Cache for SalesIntel lookups.
--
-- Two reasons this exists and neither is about saving credits:
--   1. A repeat lookup returns instantly instead of a network round trip.
--   2. If SalesIntel is rate-limiting or down during a demo, the panel
--      still shows data instead of an error.
--
-- Run in the Supabase SQL editor.

create table if not exists public.salesintel_cache (
  domain      text primary key,
  payload     jsonb       not null,
  fetched_at  timestamptz not null default now()
);

create index if not exists salesintel_cache_fetched_idx
  on public.salesintel_cache (fetched_at desc);

-- The API route uses the service role key, which bypasses RLS. Nothing in
-- the browser should ever read this table directly, so leave RLS on with
-- no policy: server can read and write, client gets nothing.
alter table public.salesintel_cache enable row level security;

comment on table public.salesintel_cache is
  'SalesIntel firmographic responses, keyed by domain. Written by api/salesintel.js.';
