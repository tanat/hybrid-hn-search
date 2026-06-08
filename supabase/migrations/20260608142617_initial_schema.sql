-- Initial schema: HN comments + their dense embeddings.
-- pgvector lives in Supabase's dedicated `extensions` schema (hosted
-- convention; avoids the "extension in public" advisory). We pin the
-- search_path for this migration so the unqualified `vector` type and
-- `vector_cosine_ops` opclass resolve from there.

create extension if not exists vector with schema extensions;

-- Session-level (not `set local`) so the unqualified `vector` type and
-- `vector_cosine_ops` opclass below resolve whether or not the migration runner
-- wraps this file in a transaction.
set search_path = public, extensions;

create table if not exists comments (
  id          bigint primary key,
  story_id    bigint not null,
  story_title text not null,
  story_url   text,
  author      text not null,
  text        text not null,
  points      integer not null default 0,
  created_at  timestamptz not null,
  parent_id   bigint,
  text_search tsvector
);

create index if not exists idx_comments_story on comments(story_id);
create index if not exists idx_comments_text_search on comments using gin(text_search);

-- Keep the FTS column in sync on write. pg_catalog functions (to_tsvector)
-- resolve regardless of search_path, so we can pin it to public for safety.
create or replace function public.comments_tsvector_trigger() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.text_search := to_tsvector('english', new.text);
  return new;
end;
$$;

drop trigger if exists tsvector_update on comments;
create trigger tsvector_update before insert or update
  on comments for each row execute function public.comments_tsvector_trigger();

create table if not exists embeddings (
  comment_id bigint primary key references comments(id) on delete cascade,
  embedding  vector(1536) not null,
  model      text not null default 'text-embedding-3-small',
  created_at timestamptz not null default now()
);

create index if not exists idx_embeddings_hnsw on embeddings
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
