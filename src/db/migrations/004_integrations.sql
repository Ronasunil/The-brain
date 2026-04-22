-- ============================================
-- Migration 004: Integrations + multi-tenant message scoping
-- Introduces per-workspace integrations (Telegram bots, Slack, etc.)
-- Adds integration_id to messages and fixes the dedup uniqueness.
-- Run this in Supabase SQL Editor.
-- ============================================

-- ─── integrations ───────────────────────────
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('telegram','slack','github','linear','manual','legacy-telegram')),
  display_name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,          -- { bot_token_ciphertext, bot_token_iv, bot_token_tag, bot_username, ... }
  webhook_secret TEXT NOT NULL,                        -- random 32-byte hex per row
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','disconnected','error')),
  last_error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_workspace ON integrations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_integrations_type_status ON integrations(type, status);

-- A single telegram bot (identified by username) can only be attached once per workspace
-- while it's not disconnected. Partial unique keeps disconnected rows as history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_telegram_bot_unique
  ON integrations(workspace_id, (config->>'bot_username'))
  WHERE type = 'telegram' AND status != 'disconnected';

DROP TRIGGER IF EXISTS trigger_integrations_updated_at ON integrations;
CREATE TRIGGER trigger_integrations_updated_at
  BEFORE UPDATE ON integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─── messages.integration_id ────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS integration_id TEXT REFERENCES integrations(id);

-- Backfill: create synthetic integrations for the 'default' workspace so existing rows have a home.
INSERT INTO integrations (id, workspace_id, type, display_name, webhook_secret, status)
VALUES
  ('legacy-telegram-default', 'default', 'legacy-telegram', 'Legacy Telegram',  encode(gen_random_bytes(32), 'hex'), 'disconnected'),
  ('manual-default',          'default', 'manual',          'Manual Notes',     encode(gen_random_bytes(32), 'hex'), 'active'),
  ('legacy-slack-default',    'default', 'slack',           'Legacy Slack',     encode(gen_random_bytes(32), 'hex'), 'disconnected'),
  ('legacy-github-default',   'default', 'github',          'Legacy GitHub',    encode(gen_random_bytes(32), 'hex'), 'disconnected'),
  ('legacy-linear-default',   'default', 'linear',          'Legacy Linear',    encode(gen_random_bytes(32), 'hex'), 'disconnected')
ON CONFLICT (id) DO NOTHING;

UPDATE messages SET integration_id = 'legacy-telegram-default' WHERE integration_id IS NULL AND source = 'telegram';
UPDATE messages SET integration_id = 'manual-default'          WHERE integration_id IS NULL AND source = 'manual';
UPDATE messages SET integration_id = 'legacy-slack-default'    WHERE integration_id IS NULL AND source = 'slack';
UPDATE messages SET integration_id = 'legacy-github-default'   WHERE integration_id IS NULL AND source = 'github';
UPDATE messages SET integration_id = 'legacy-linear-default'   WHERE integration_id IS NULL AND source = 'linear';

ALTER TABLE messages ALTER COLUMN integration_id SET NOT NULL;

-- Replace old UNIQUE(source, source_message_id) with UNIQUE(integration_id, chat_id, source_message_id).
-- Telegram message_id is only unique within a chat, so a single bot in multiple groups can emit
-- colliding message_ids. The chat_id is part of the dedup key.
DO $$
DECLARE
  cons_name TEXT;
BEGIN
  SELECT conname INTO cons_name
  FROM pg_constraint
  WHERE conrelid = 'messages'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) ILIKE '%(source, source_message_id)%';

  IF cons_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', cons_name);
  END IF;
END $$;

ALTER TABLE messages
  ADD CONSTRAINT messages_integration_chat_message_key
  UNIQUE (integration_id, chat_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_messages_integration ON messages(integration_id);

-- ─── Update search functions to accept optional integration filter ───
-- Passing NULL (or omitting the arg) preserves the existing workspace-only behaviour.

CREATE OR REPLACE FUNCTION search_messages(
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
    m.integration_id,
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
    AND (match_integration_id IS NULL OR m.integration_id = match_integration_id)
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION search_messages_fulltext(
  search_query TEXT,
  match_workspace_id TEXT,
  match_count INT DEFAULT 20,
  match_integration_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
  source TEXT,
  source_message_id TEXT,
  user_name TEXT,
  user_id TEXT,
  chat_id TEXT,
  chat_name TEXT,
  content TEXT,
  "timestamp" TIMESTAMPTZ,
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
    m.id,
    m.workspace_id,
    m.integration_id,
    m.source,
    m.source_message_id,
    m.user_name,
    m.user_id,
    m.chat_id,
    m.chat_name,
    m.content,
    m."timestamp",
    m.created_at,
    ts_rank(m.search_vector, tsquery_val)::FLOAT AS rank
  FROM messages m
  WHERE m.workspace_id = match_workspace_id
    AND (match_integration_id IS NULL OR m.integration_id = match_integration_id)
    AND m.search_vector @@ tsquery_val
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION search_messages_manual(
  query_embedding VECTOR(1024),
  match_workspace_id TEXT,
  match_count INT DEFAULT 3,
  similarity_threshold FLOAT DEFAULT 0.3,
  match_integration_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  workspace_id TEXT,
  integration_id TEXT,
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
    m.integration_id,
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
    AND (match_integration_id IS NULL OR m.integration_id = match_integration_id)
    AND m.source = 'manual'
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

