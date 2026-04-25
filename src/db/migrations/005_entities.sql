-- ============================================
-- Migration 005: entities + entity_comments + entity_links
-- First-class storage for structured, mutable objects (Linear tickets today,
-- GitHub PRs / Notion pages / Jira issues later) alongside the chat-shaped
-- `messages` table. See docs/prds/PRD-linear-integration-2026-04-23.md
-- All vectors are 1024-dim to match the Cohere-based pipeline.
-- Run this in Supabase SQL Editor AFTER 004.
-- ============================================

-- ─── Part 1: entities table ─────────────────

CREATE TABLE IF NOT EXISTS entities (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id        TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL CHECK (type IN (
    'linear_ticket','github_issue','github_pr','notion_page','jira_issue'
  )),
  external_id           TEXT NOT NULL,
  external_url          TEXT NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  body                  TEXT NOT NULL DEFAULT '',
  state                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  participants          JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash          TEXT NOT NULL DEFAULT '',
  external_created_at   TIMESTAMPTZ NOT NULL,
  external_updated_at   TIMESTAMPTZ NOT NULL,
  embedding             VECTOR(1024),
  search_vector         TSVECTOR,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT entities_embedding_dim_chk
    CHECK (embedding IS NULL OR vector_dims(embedding) = 1024),
  CONSTRAINT entities_external_unique
    UNIQUE (integration_id, external_id)
);

DROP TRIGGER IF EXISTS trigger_entities_updated_at ON entities;
CREATE TRIGGER trigger_entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Auto-populate search_vector only when title or body change.
-- State-only updates (status flip, reassign) skip this trigger.
CREATE OR REPLACE FUNCTION entities_search_vector_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.body, '')),  'B');
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_entities_search_vector ON entities;
CREATE TRIGGER trg_entities_search_vector
  BEFORE INSERT OR UPDATE OF title, body ON entities
  FOR EACH ROW
  EXECUTE FUNCTION entities_search_vector_trigger();

-- ─── Indexes on entities ───────────────────

-- Tenancy + type scope (covers every query)
CREATE INDEX IF NOT EXISTS idx_entities_workspace_integration_type
  ON entities (workspace_id, integration_id, type);

-- Recency ("recently updated tickets")
CREATE INDEX IF NOT EXISTS idx_entities_workspace_updated
  ON entities (workspace_id, external_updated_at DESC);

-- Semantic search
CREATE INDEX IF NOT EXISTS idx_entities_embedding
  ON entities
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Full-text search
CREATE INDEX IF NOT EXISTS idx_entities_search_vector
  ON entities USING gin (search_vector);

-- Hot path: "open tickets assigned to X" — partial keeps closed rows out.
CREATE INDEX IF NOT EXISTS idx_entities_open_by_assignee
  ON entities (workspace_id, (state->>'assignee_id'))
  WHERE type = 'linear_ticket'
    AND state->>'status' IN ('backlog','unstarted','started');

-- Hot path: "open by priority"
CREATE INDEX IF NOT EXISTS idx_entities_open_by_priority
  ON entities (workspace_id, (state->>'priority'))
  WHERE type = 'linear_ticket'
    AND state->>'status' IN ('backlog','unstarted','started');

-- Cycle scoping
CREATE INDEX IF NOT EXISTS idx_entities_cycle
  ON entities (workspace_id, (state->>'cycle_id'))
  WHERE type = 'linear_ticket'
    AND state->>'cycle_id' IS NOT NULL;

-- Long-tail JSONB filter fallback
CREATE INDEX IF NOT EXISTS idx_entities_state_gin
  ON entities USING gin (state jsonb_path_ops);

-- Content-hash lookup for upsert path (skip re-embed when unchanged)
CREATE INDEX IF NOT EXISTS idx_entities_content_hash
  ON entities (integration_id, content_hash);

-- Workspace-scoped external-id lookup for direct "ENG-423" queries.
-- Complements the (integration_id, external_id) unique index when the
-- integration is unknown at query time (common for /brain/ask).
CREATE INDEX IF NOT EXISTS idx_entities_workspace_external_id
  ON entities (workspace_id, external_id);

-- "What did X finish today/this week" — time-range on completed_at.
-- Partial: only closed tickets have a completed_at worth indexing.
CREATE INDEX IF NOT EXISTS idx_entities_completed_at
  ON entities (workspace_id, (state->>'completed_at') DESC)
  WHERE type = 'linear_ticket'
    AND state->>'completed_at' IS NOT NULL;

-- Fuzzy name lookup: "tickets assigned to Ron" → ILIKE '%ron%'.
-- Case-insensitive expression index (lower()).
CREATE INDEX IF NOT EXISTS idx_entities_assignee_name_lower
  ON entities (workspace_id, LOWER(state->>'assignee_name'))
  WHERE type = 'linear_ticket'
    AND state->>'assignee_name' IS NOT NULL;

-- ─── Part 2: entity_comments ───────────────

CREATE TABLE IF NOT EXISTS entity_comments (
  id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  entity_id             TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id           TEXT NOT NULL,
  author_id             TEXT NOT NULL DEFAULT '',
  author_name           TEXT NOT NULL DEFAULT 'unknown',
  content               TEXT NOT NULL,
  embedding             VECTOR(1024),
  search_vector         TSVECTOR,
  external_created_at   TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT entity_comments_embedding_dim_chk
    CHECK (embedding IS NULL OR vector_dims(embedding) = 1024),
  CONSTRAINT entity_comments_external_unique
    UNIQUE (entity_id, external_id)
);

CREATE OR REPLACE FUNCTION entity_comments_search_vector_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_entity_comments_search_vector ON entity_comments;
CREATE TRIGGER trg_entity_comments_search_vector
  BEFORE INSERT OR UPDATE OF content ON entity_comments
  FOR EACH ROW
  EXECUTE FUNCTION entity_comments_search_vector_trigger();

CREATE INDEX IF NOT EXISTS idx_entity_comments_entity
  ON entity_comments (entity_id, external_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_comments_workspace
  ON entity_comments (workspace_id, external_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_comments_embedding
  ON entity_comments
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

CREATE INDEX IF NOT EXISTS idx_entity_comments_search_vector
  ON entity_comments USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_entity_comments_author
  ON entity_comments (workspace_id, author_id);

-- ─── Part 2.5: safe concurrent config merge ─
-- Merge a JSONB patch into integrations.config atomically so two concurrent
-- webhook/backfill writes can't clobber each other's keys.

CREATE OR REPLACE FUNCTION merge_integration_config(
  integration_id_in TEXT,
  patch_in JSONB
)
RETURNS SETOF integrations
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  UPDATE integrations
  SET config = COALESCE(config, '{}'::jsonb) || patch_in,
      updated_at = NOW()
  WHERE id = integration_id_in
  RETURNING *;
END; $$;

-- ─── Part 2.6: linear_events queue ─────────
-- Persistent webhook queue. The webhook controller INSERTs here before
-- returning 200; the worker drains unprocessed rows. If the process dies
-- between INSERT and processing, the row survives and drains on restart.

CREATE TABLE IF NOT EXISTS linear_events (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  integration_id  TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  payload         JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_linear_events_unprocessed
  ON linear_events (received_at)
  WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION linear_event_record_failure(
  event_id_in TEXT,
  reason_in TEXT
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE linear_events
  SET attempts = attempts + 1,
      last_error = reason_in
  WHERE id = event_id_in;
END; $$;

-- ─── Part 3: entity_links ──────────────────

CREATE TABLE IF NOT EXISTS entity_links (
  from_entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
    'mentions','closes','blocks','duplicates','related'
  )),
  confidence       FLOAT NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_entity_id, to_entity_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_entity_links_to
  ON entity_links (to_entity_id, kind);

-- ─── Part 4: search RPCs for entities ─────

CREATE OR REPLACE FUNCTION search_entities(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3,
  match_integration_id TEXT DEFAULT NULL,
  match_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
  type TEXT,
  external_id TEXT,
  external_url TEXT,
  title TEXT,
  body TEXT,
  state JSONB,
  external_updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id, e.workspace_id, e.integration_id, e.type,
    e.external_id, e.external_url, e.title, e.body,
    e.state, e.external_updated_at,
    1 - (e.embedding <=> query_embedding) AS similarity
  FROM entities e
  WHERE e.workspace_id = match_workspace_id
    AND (match_integration_id IS NULL OR e.integration_id = match_integration_id)
    AND (match_type IS NULL OR e.type = match_type)
    AND e.embedding IS NOT NULL
    AND 1 - (e.embedding <=> query_embedding) > similarity_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END; $$;

CREATE OR REPLACE FUNCTION search_entities_fulltext(
  search_query TEXT,
  match_workspace_id TEXT,
  match_count INT DEFAULT 20,
  match_integration_id TEXT DEFAULT NULL,
  match_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
  type TEXT,
  external_id TEXT,
  external_url TEXT,
  title TEXT,
  body TEXT,
  state JSONB,
  external_updated_at TIMESTAMPTZ,
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
    e.id, e.workspace_id, e.integration_id, e.type,
    e.external_id, e.external_url, e.title, e.body,
    e.state, e.external_updated_at,
    ts_rank(e.search_vector, tsquery_val)::FLOAT AS rank
  FROM entities e
  WHERE e.workspace_id = match_workspace_id
    AND (match_integration_id IS NULL OR e.integration_id = match_integration_id)
    AND (match_type IS NULL OR e.type = match_type)
    AND e.search_vector @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
END; $$;

CREATE OR REPLACE FUNCTION search_entity_comments(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id TEXT,
  entity_id TEXT,
  workspace_id TEXT,
  author_id TEXT,
  author_name TEXT,
  content TEXT,
  external_created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id, c.entity_id, c.workspace_id,
    c.author_id, c.author_name, c.content, c.external_created_at,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM entity_comments c
  WHERE c.workspace_id = match_workspace_id
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END; $$;
