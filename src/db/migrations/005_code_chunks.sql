-- ============================================
-- Migration 005: Code Chunks for GitHub Codebase Indexing
-- Dedicated table for storing indexed code from GitHub repos.
-- Includes cosine + full-text search RPCs matching the messages pattern.
-- Run this in Supabase SQL Editor.
-- ============================================

-- ─── code_chunks table ──────────────────────
CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  language TEXT,
  chunk_type TEXT NOT NULL DEFAULT 'file',
  line_start INTEGER,
  line_end INTEGER,
  content TEXT NOT NULL,
  embedding VECTOR(1024),
  search_vector TSVECTOR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(integration_id, file_path, line_start)
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_workspace ON code_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_integration ON code_chunks(integration_id);
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding ON code_chunks
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_code_chunks_search_vector ON code_chunks
  USING GIN (search_vector);

-- ─── Auto-generate search_vector from file_path + content ───
CREATE OR REPLACE FUNCTION code_chunks_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.file_path, '') || ' ' || NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_code_chunks_search_vector
  BEFORE INSERT OR UPDATE OF content ON code_chunks
  FOR EACH ROW
  EXECUTE FUNCTION code_chunks_search_vector_trigger();

-- ─── updated_at trigger ─────────────────────
DROP TRIGGER IF EXISTS trigger_code_chunks_updated_at ON code_chunks;
CREATE TRIGGER trigger_code_chunks_updated_at
  BEFORE UPDATE ON code_chunks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─── Cosine similarity search ───────────────
CREATE OR REPLACE FUNCTION search_code_chunks(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3,
  match_integration_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
  file_path TEXT,
  repo_name TEXT,
  language TEXT,
  chunk_type TEXT,
  line_start INTEGER,
  line_end INTEGER,
  content TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.workspace_id,
    c.integration_id,
    c.file_path,
    c.repo_name,
    c.language,
    c.chunk_type,
    c.line_start,
    c.line_end,
    c.content,
    c.created_at,
    (1 - (c.embedding <=> query_embedding))::FLOAT AS similarity
  FROM code_chunks c
  WHERE c.workspace_id = match_workspace_id
    AND (match_integration_id IS NULL OR c.integration_id = match_integration_id)
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ─── Full-text search ───────────────────────
CREATE OR REPLACE FUNCTION search_code_chunks_fulltext(
  search_query TEXT,
  match_workspace_id TEXT,
  match_count INT DEFAULT 20,
  match_integration_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
  file_path TEXT,
  repo_name TEXT,
  language TEXT,
  chunk_type TEXT,
  line_start INTEGER,
  line_end INTEGER,
  content TEXT,
  created_at TIMESTAMPTZ,
  rank FLOAT
)
LANGUAGE plpgsql AS $$
DECLARE
  tsquery_val TSQUERY;
BEGIN
  tsquery_val := plainto_tsquery('english', search_query);

  IF tsquery_val = ''::TSQUERY THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.workspace_id,
    c.integration_id,
    c.file_path,
    c.repo_name,
    c.language,
    c.chunk_type,
    c.line_start,
    c.line_end,
    c.content,
    c.created_at,
    ts_rank(c.search_vector, tsquery_val)::FLOAT AS rank
  FROM code_chunks c
  WHERE c.workspace_id = match_workspace_id
    AND (match_integration_id IS NULL OR c.integration_id = match_integration_id)
    AND c.search_vector @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
