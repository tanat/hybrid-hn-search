-- Retrieval RPCs called from the app via supabase-js (.rpc()).
-- Two separate functions (dense + sparse) rather than one hybrid function:
-- RRF fusion and cross-encoder reranking happen in JS (retrieve/fuse.ts,
-- retrieve/rerank.ts) so the eval harness can score each stage in isolation.
--
-- Both are SECURITY DEFINER with a pinned search_path: that lets them read the
-- private `embeddings` table (no anon RLS policy on it) while keeping the
-- attack surface fixed. `vector` / `<=>` resolve from the extensions schema.

-- Session-level search_path so the `<=>` operator (extensions schema) resolves
-- while the SQL function bodies are parsed at CREATE time. Each function also
-- pins its own search_path for run time.
set search_path = public, extensions;

-- Dense retrieval: top-k by cosine similarity to the query embedding.
create or replace function public.match_comments(
  query_embedding extensions.vector(1536),
  match_count int default 50
)
returns table (
  id          bigint,
  story_id    bigint,
  story_title text,
  story_url   text,
  author      text,
  text        text,
  points      int,
  created_at  timestamptz,
  score       double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.id, c.story_id, c.story_title, c.story_url, c.author, c.text,
         c.points, c.created_at,
         1 - (e.embedding <=> query_embedding) as score
  from embeddings e
  join comments c on c.id = e.comment_id
  order by e.embedding <=> query_embedding
  limit match_count
$$;

-- Sparse retrieval: full-text search with BM25-like ts_rank_cd scoring.
-- plainto_tsquery uses AND (near-zero hits on a small corpus), so we extract
-- individual lexemes and OR them together — ranking still rewards documents
-- that match more terms.
create or replace function public.search_comments(
  query_text text,
  match_count int default 50
)
returns table (
  id          bigint,
  story_id    bigint,
  story_title text,
  story_url   text,
  author      text,
  text        text,
  points      int,
  created_at  timestamptz,
  score       double precision
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select c.id, c.story_id, c.story_title, c.story_url, c.author, c.text,
         c.points, c.created_at,
         ts_rank_cd(c.text_search, query) as score
  from comments c,
       to_tsquery('english',
         array_to_string(
           array(select lexeme from unnest(to_tsvector('english', query_text))),
           ' | '
         )
       ) query
  where c.text_search @@ query
  order by score desc
  limit match_count
$$;

grant execute on function public.match_comments(extensions.vector, int) to anon, authenticated;
grant execute on function public.search_comments(text, int) to anon, authenticated;
