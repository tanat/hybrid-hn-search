-- db/schema.sql
-- Authoritative schema. Mirrored by db/migrations/001_initial.sql.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT PRIMARY KEY,
  story_id BIGINT NOT NULL,
  story_title TEXT NOT NULL,
  story_url TEXT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  parent_id BIGINT,
  text_search tsvector
);

CREATE INDEX IF NOT EXISTS idx_comments_story ON comments(story_id);
CREATE INDEX IF NOT EXISTS idx_comments_text_search ON comments USING GIN(text_search);

CREATE OR REPLACE FUNCTION comments_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.text_search := to_tsvector('english', NEW.text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tsvector_update ON comments;
CREATE TRIGGER tsvector_update BEFORE INSERT OR UPDATE
  ON comments FOR EACH ROW EXECUTE FUNCTION comments_tsvector_trigger();

CREATE TABLE IF NOT EXISTS embeddings (
  comment_id BIGINT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  embedding vector(1536) NOT NULL,
  model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw ON embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
