-- ============================================
-- OrgBrain V1 — Auth & Users Schema
-- Run this in Supabase SQL Editor
-- ============================================

-- ─── Users ──────────────────────────────────
-- Profile data for authenticated users.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_url TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Auth ───────────────────────────────────
-- Credentials & security state. 1:1 with users.
CREATE TABLE IF NOT EXISTS auth (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  is_valid BOOLEAN NOT NULL DEFAULT true,
  otp TEXT,
  otp_expires_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Alter Workspaces — add user_id ────────
-- Workspace belongs to a user. Nullable for backward compat (default workspace has no owner).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);

-- ─── Indexes ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE INDEX IF NOT EXISTS idx_auth_user_id ON auth(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_email ON auth(email);
CREATE INDEX IF NOT EXISTS idx_auth_username ON auth(username);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

-- ─── Updated_at Trigger Function ────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Apply Trigger to users ─────────────────
DROP TRIGGER IF EXISTS trigger_users_updated_at ON users;
CREATE TRIGGER trigger_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─── Apply Trigger to auth ──────────────────
DROP TRIGGER IF EXISTS trigger_auth_updated_at ON auth;
CREATE TRIGGER trigger_auth_updated_at
  BEFORE UPDATE ON auth
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
