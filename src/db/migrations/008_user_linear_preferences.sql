-- ============================================
-- Migration 008: user_linear_preferences
--
-- Per-user, per-Linear-integration "sticky defaults" for the @brain
-- ticket creation flow. Today we only need `last_team_id` so that the
-- second time a user creates a ticket we don't have to ask which team
-- to file it under, but the table is shaped to grow (default priority,
-- default assignee, etc.) without a second migration.
--
-- Run this in Supabase SQL Editor.
-- ============================================

CREATE TABLE IF NOT EXISTS user_linear_preferences (
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  last_team_id   TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, integration_id)
);

CREATE INDEX IF NOT EXISTS idx_user_linear_prefs_integration
  ON user_linear_preferences (integration_id);
