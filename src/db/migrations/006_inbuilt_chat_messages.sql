-- ============================================
-- Migration 006: Inbuilt Chat Messages
-- Stores the group chat thread for the in-app web chat.
-- Each workspace has one shared thread visible to all members.
-- This is separate from the `messages` table (RAG content);
-- user messages are also ingested into `messages` via MessageService.
-- Run this in Supabase SQL Editor.
-- ============================================

CREATE TABLE IF NOT EXISTS inbuilt_chat_messages (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT,
  user_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbuilt_chat_workspace_time
  ON inbuilt_chat_messages (workspace_id, created_at DESC);
