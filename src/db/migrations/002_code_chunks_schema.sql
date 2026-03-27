-- ============================================
-- OrgBrain V1.1 — Code Chunks Schema
-- Run this in Supabase SQL Editor AFTER 001
-- ============================================

-- ─── Fix existing dimension mismatch ────────
-- All providers output 1024-dim vectors, but 001 defined VECTOR(1536).
-- If messages.embedding has data with 1536 dims this will fail —
-- in that case, drop and recreate the column instead.




-- Recreate search_messages function with corrected VECTOR(1024)




-- ─── Code Chunks Table ──────────────────────
CREATE TABLE IF NOT EXISTS code_chunks (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  source_chunk_id TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  repo_name       TEXT NOT NULL DEFAULT '',
  language        TEXT NOT NULL DEFAULT '',
  chunk_index     INT NOT NULL DEFAULT 0,
  content         TEXT NOT NULL,
  embedding       VECTOR(1024),
  search_vector   TSVECTOR,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(workspace_id, source_chunk_id)
);

-- ─── Code Chunks Indexes ────────────────────
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
  ON code_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_code_chunks_search_vector
  ON code_chunks USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace
  ON code_chunks(workspace_id);

CREATE INDEX IF NOT EXISTS idx_code_chunks_file_path
  ON code_chunks(file_path);

CREATE INDEX IF NOT EXISTS idx_code_chunks_repo_name
  ON code_chunks(repo_name);

-- ─── Code Chunks Full-Text Trigger ──────────
CREATE OR REPLACE FUNCTION code_chunks_search_vector_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_code_chunks_search_vector ON code_chunks;
CREATE TRIGGER trg_code_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content ON code_chunks
  FOR EACH ROW
  EXECUTE FUNCTION code_chunks_search_vector_trigger();

-- ─── Code Chunks Vector Search ──────────────
CREATE OR REPLACE FUNCTION search_code_chunks(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  source_chunk_id TEXT,
  file_path TEXT,
  repo_name TEXT,
  language TEXT,
  chunk_index INT,
  content TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id, c.workspace_id, c.source_chunk_id,
    c.file_path, c.repo_name, c.language, c.chunk_index,
    c.content, c.created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM code_chunks c
  WHERE c.workspace_id = match_workspace_id
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─── Code Chunks Full-Text Search ───────────
CREATE OR REPLACE FUNCTION search_code_chunks_fulltext(
  search_query TEXT,
  match_workspace_id TEXT,
  match_count INT DEFAULT 20
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  source_chunk_id TEXT,
  file_path TEXT,
  repo_name TEXT,
  language TEXT,
  chunk_index INT,
  content TEXT,
  created_at TIMESTAMPTZ,
  rank FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  tsquery_val TSQUERY;
BEGIN
  tsquery_val := plainto_tsquery('english', search_query);

  IF tsquery_val = ''::TSQUERY THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id, c.workspace_id, c.source_chunk_id,
    c.file_path, c.repo_name, c.language, c.chunk_index,
    c.content, c.created_at,
    ts_rank(c.search_vector, tsquery_val)::FLOAT AS rank
  FROM code_chunks c
  WHERE c.workspace_id = match_workspace_id
    AND c.search_vector @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
