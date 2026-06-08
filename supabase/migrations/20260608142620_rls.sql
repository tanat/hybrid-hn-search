-- Row Level Security: a public, read-only search surface.
--
-- `comments` is world-readable (it's already-public Hacker News data) so the
-- search UI can run on the anon key. `embeddings` has RLS on with NO policy, so
-- it is unreachable directly by anon/authenticated — the 1536-dim vectors are
-- only ever read through the SECURITY DEFINER match_comments() function.
--
-- Ingestion (ingest/*.ts) connects as the postgres superuser over the direct
-- DATABASE_URL and bypasses RLS entirely.

alter table public.comments  enable row level security;
alter table public.embeddings enable row level security;

drop policy if exists "comments are publicly readable" on public.comments;
create policy "comments are publicly readable"
  on public.comments
  for select
  to anon, authenticated
  using (true);

-- Table + schema privileges (RLS sits on top of these grants).
grant usage on schema extensions to anon, authenticated;
grant select on public.comments to anon, authenticated;
