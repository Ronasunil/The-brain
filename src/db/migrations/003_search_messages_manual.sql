-- ============================================
-- Migration 003: search_messages_manual function
-- Semantic search restricted to source='manual' rows.
-- Uses the existing idx_messages_source index for the source filter.
-- Run this in Supabase SQL Editor.
-- ============================================

CREATE OR REPLACE FUNCTION search_messages_manual(
  query_embedding VECTOR(1536),
  match_workspace_id TEXT,
  match_count INT DEFAULT 3,
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
  "timestamp" TIMESTAMPTZ,
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
    m."timestamp",
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.workspace_id = match_workspace_id
    AND m.source = 'manual'
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
