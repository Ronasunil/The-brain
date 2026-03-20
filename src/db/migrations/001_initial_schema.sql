-- ============================================
-- OrgBrain V1 — Database Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Workspaces ─────────────────────────────
-- Each company/team gets a workspace for data isolation.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default workspace for V1
INSERT INTO workspaces (id, name)
VALUES ('default', 'Default Workspace')
ON CONFLICT (id) DO NOTHING;

-- ─── Messages ───────────────────────────────
-- All ingested messages from every platform.
-- This is the raw event store (source of truth).
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL,                    -- telegram, slack, github, etc.
  source_message_id TEXT NOT NULL,         -- original message ID from platform
  user_name TEXT NOT NULL DEFAULT 'unknown',
  user_id TEXT NOT NULL DEFAULT '',
  chat_id TEXT NOT NULL DEFAULT '',
  chat_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  embedding VECTOR(1536),                  -- OpenAI text-embedding-3-small
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate messages from the same source
  UNIQUE(source, source_message_id)
);

-- ─── Indexes ────────────────────────────────
-- Vector similarity search index (IVFFlat for fast approximate search)
CREATE INDEX IF NOT EXISTS idx_messages_embedding
  ON messages
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Filter indexes
CREATE INDEX IF NOT EXISTS idx_messages_workspace
  ON messages(workspace_id);

CREATE INDEX IF NOT EXISTS idx_messages_source
  ON messages(source);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp
  ON messages(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id
  ON messages(chat_id);

-- ─── Vector Search Function ─────────────────
-- Searches for similar messages using cosine similarity.
-- Returns top N results above a similarity threshold.
CREATE OR REPLACE FUNCTION search_messages(
  query_embedding VECTOR(1536),
  match_workspace_id TEXT,
  match_count INT DEFAULT 5,
  similarity_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  source TEXT,
  source_message_id TEXT,
  user_name TEXT,
  user_id TEXT,
  chat_id TEXT,
  chat_name TEXT,
  content TEXT,
  timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.workspace_id,
    m.source,
    m.source_message_id,
    m.user_name,
    m.user_id,
    m.chat_id,
    m.chat_name,
    m.content,
    m.timestamp,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.workspace_id = match_workspace_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
