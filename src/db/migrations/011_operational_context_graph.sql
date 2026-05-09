CREATE TABLE IF NOT EXISTS operational_episodes (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  episode_type  TEXT NOT NULL DEFAULT 'event' CHECK (episode_type IN (
    'event','message','text','json','memory'
  )),
  content       TEXT NOT NULL DEFAULT '',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_operational_episodes_workspace_time
  ON operational_episodes (workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS operational_entities (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN (
    'person','repo','service','workflow','decision','owner','ticket','tool',
    'file','memory','risk','customer_signal','unknown'
  )),
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  confidence      FLOAT NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, kind, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_operational_entities_workspace_kind
  ON operational_entities (workspace_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS operational_facts (
  id                 TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_entity_id  TEXT NOT NULL REFERENCES operational_entities(id) ON DELETE CASCADE,
  predicate          TEXT NOT NULL,
  object_entity_id   TEXT REFERENCES operational_entities(id) ON DELETE SET NULL,
  object_text        TEXT,
  fact               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active','superseded','rejected','archived'
  )),
  confidence         FLOAT NOT NULL DEFAULT 0.7 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until        TIMESTAMPTZ,
  superseded_by      TEXT REFERENCES operational_facts(id) ON DELETE SET NULL,
  source_episode_id  TEXT REFERENCES operational_episodes(id) ON DELETE SET NULL,
  source_memory_id   TEXT REFERENCES operational_memories(id) ON DELETE SET NULL,
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_facts_workspace_subject
  ON operational_facts (workspace_id, subject_entity_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_operational_facts_workspace_object
  ON operational_facts (workspace_id, object_entity_id, valid_from DESC)
  WHERE object_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_facts_workspace_status
  ON operational_facts (workspace_id, status, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_operational_facts_memory
  ON operational_facts (workspace_id, source_memory_id)
  WHERE source_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_operational_facts_episode
  ON operational_facts (workspace_id, source_episode_id)
  WHERE source_episode_id IS NOT NULL;
