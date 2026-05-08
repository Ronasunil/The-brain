-- ============================================
-- Migration 009: Operational Memory + Agent Runs
-- Shadow-mode memory proposed by connected agent modules.
-- Run in Supabase SQL Editor after existing migrations.
-- ============================================

CREATE TABLE IF NOT EXISTS operational_memories (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN (
    'workflow','decision','ownership','tool_capability','procedure'
  )),
  title               TEXT NOT NULL DEFAULT '',
  summary             TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed','approved','rejected','archived'
  )),
  confidence          FLOAT NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_by_agent    TEXT NOT NULL DEFAULT '',
  approved_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  source_fingerprint  TEXT,
  freshness_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  embedding           VECTOR(1024),
  search_vector       TSVECTOR,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operational_memories_embedding_dim_chk
    CHECK (embedding IS NULL OR vector_dims(embedding) = 1024),
  CONSTRAINT operational_memories_source_fingerprint_unique
    UNIQUE (workspace_id, source_fingerprint)
);

DROP TRIGGER IF EXISTS trigger_operational_memories_updated_at ON operational_memories;
CREATE TRIGGER trigger_operational_memories_updated_at
  BEFORE UPDATE ON operational_memories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION operational_memories_search_vector_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')),   'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.body, '')),    'C');
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_operational_memories_search_vector ON operational_memories;
CREATE TRIGGER trg_operational_memories_search_vector
  BEFORE INSERT OR UPDATE OF title, summary, body ON operational_memories
  FOR EACH ROW
  EXECUTE FUNCTION operational_memories_search_vector_trigger();

CREATE INDEX IF NOT EXISTS idx_operational_memories_workspace_status_kind
  ON operational_memories (workspace_id, status, kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_memories_embedding
  ON operational_memories
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_operational_memories_search_vector
  ON operational_memories USING gin (search_vector);

CREATE TABLE IF NOT EXISTS operational_memory_evidence (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  memory_id     TEXT NOT NULL REFERENCES operational_memories(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  excerpt       TEXT NOT NULL DEFAULT '',
  score         FLOAT NOT NULL DEFAULT 1.0
    CHECK (score >= 0.0 AND score <= 1.0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_memory_evidence_memory
  ON operational_memory_evidence (memory_id, score DESC);

CREATE TABLE IF NOT EXISTS operational_memory_edges (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  from_id       TEXT NOT NULL REFERENCES operational_memories(id) ON DELETE CASCADE,
  to_id         TEXT NOT NULL REFERENCES operational_memories(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN (
    'owns','depends_on','decided_by','uses_tool','evidence_for','supersedes','related'
  )),
  confidence    FLOAT NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_operational_memory_edges_workspace
  ON operational_memory_edges (workspace_id, kind);

CREATE TABLE IF NOT EXISTS agent_events (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN (
    'message_ingested','chat_message_ingested','linear_entity_updated',
    'github_repo_indexed','memory_approved','user_agent_request'
  )),
  subject_refs  JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_unprocessed
  ON agent_events (workspace_id, created_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_runs (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id      TEXT REFERENCES agent_events(id) ON DELETE SET NULL,
  module_name   TEXT NOT NULL,
  input         JSONB NOT NULL DEFAULT '{}'::jsonb,
  output        JSONB,
  status        TEXT NOT NULL DEFAULT 'started' CHECK (status IN (
    'started','completed','failed'
  )),
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_workspace_started
  ON agent_runs (workspace_id, started_at DESC);

CREATE OR REPLACE FUNCTION search_operational_memories(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3,
  match_status TEXT DEFAULT 'approved'
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  kind TEXT,
  title TEXT,
  summary TEXT,
  body TEXT,
  status TEXT,
  confidence FLOAT,
  created_by_agent TEXT,
  approved_by TEXT,
  source_fingerprint TEXT,
  freshness_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.workspace_id, m.kind, m.title, m.summary, m.body, m.status,
    m.confidence, m.created_by_agent, m.approved_by, m.source_fingerprint,
    m.freshness_at, m.created_at, m.updated_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM operational_memories m
  WHERE m.workspace_id = match_workspace_id
    AND (match_status IS NULL OR m.status = match_status)
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END; $$;

CREATE OR REPLACE FUNCTION search_operational_memories_fulltext(
  search_query TEXT,
  match_workspace_id TEXT,
  match_count INT DEFAULT 20,
  match_status TEXT DEFAULT 'approved'
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  kind TEXT,
  title TEXT,
  summary TEXT,
  body TEXT,
  status TEXT,
  confidence FLOAT,
  created_by_agent TEXT,
  approved_by TEXT,
  source_fingerprint TEXT,
  freshness_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  rank FLOAT
)
LANGUAGE plpgsql AS $$
DECLARE
  tsquery_val TSQUERY;
BEGIN
  tsquery_val := plainto_tsquery('english', search_query);
  IF tsquery_val = ''::TSQUERY THEN RETURN; END IF;

  RETURN QUERY
  SELECT
    m.id, m.workspace_id, m.kind, m.title, m.summary, m.body, m.status,
    m.confidence, m.created_by_agent, m.approved_by, m.source_fingerprint,
    m.freshness_at, m.created_at, m.updated_at,
    ts_rank(m.search_vector, tsquery_val)::FLOAT AS rank
  FROM operational_memories m
  WHERE m.workspace_id = match_workspace_id
    AND (match_status IS NULL OR m.status = match_status)
    AND m.search_vector @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
END; $$;
