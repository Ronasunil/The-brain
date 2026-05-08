CREATE TABLE IF NOT EXISTS token_usage_events (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  operation          TEXT NOT NULL CHECK (operation IN (
    'chat_completion','embedding','rerank','query_planning','other'
  )),
  source             TEXT NOT NULL DEFAULT 'unknown',
  input_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens       INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  input_price_usd    NUMERIC(14, 8) NOT NULL DEFAULT 0,
  output_price_usd   NUMERIC(14, 8) NOT NULL DEFAULT 0,
  estimated_cost_usd NUMERIC(14, 8) NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'USD',
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_created
  ON token_usage_events (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_model
  ON token_usage_events (workspace_id, model, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_workspace_operation
  ON token_usage_events (workspace_id, operation, created_at DESC);
