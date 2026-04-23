-- ============================================
-- Migration 006: enrich search_vector with structured state fields
-- Goal: make questions like "assigned to rona@tghtech" or "P1 backend work"
-- answerable via FTS without a regex classifier. We stringify key state
-- fields (assignee, email, status, priority, project, team, labels) into the
-- tsvector at weights A/B/C so ranking stays sane.
--
-- Weights:
--   A — external_id ("ENG-423") and title   (top match boost)
--   B — state strings (assignee name+email, status, priority, project, team, labels)
--   C — body (rich content, lower unit weight)
--
-- Run this in Supabase SQL Editor AFTER 005.
-- ============================================

-- ─── entities ───────────────────────────────

CREATE OR REPLACE FUNCTION entities_search_vector_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  state_text TEXT;
  labels_text TEXT;
BEGIN
  -- Flatten label array to a space-separated string.
  SELECT COALESCE(string_agg(value, ' '), '')
  INTO labels_text
  FROM jsonb_array_elements_text(COALESCE(NEW.state->'labels', '[]'::jsonb));

  -- Stringify the state keys worth indexing. Null-safe.
  state_text := trim(both ' ' FROM concat_ws(
    ' ',
    NEW.state->>'assignee_name',
    NEW.state->>'assignee_email',
    NEW.state->>'creator_name',
    NEW.state->>'creator_email',
    NEW.state->>'status_name',
    NEW.state->>'priority_label',
    NEW.state->>'project_name',
    NEW.state->>'team_key',
    labels_text
  ));

  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.external_id, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.title, '')),       'A') ||
    setweight(to_tsvector('english', state_text),                     'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.body, '')),        'C');
  RETURN NEW;
END; $$;

-- Trigger must fire on state changes too — enriched tsvector depends on it.
-- State-only updates stay cheap: tsvector rebuild is pure string tokenization,
-- no vector/ivfflat writes happen because embedding column is untouched.
DROP TRIGGER IF EXISTS trg_entities_search_vector ON entities;
CREATE TRIGGER trg_entities_search_vector
  BEFORE INSERT OR UPDATE OF title, body, state, external_id ON entities
  FOR EACH ROW
  EXECUTE FUNCTION entities_search_vector_trigger();

-- Force rebuild of search_vector for every existing row so the enriched
-- tsvector applies immediately without waiting for new webhook events.
-- `SET title = title` is a no-op write that fires the trigger above.
UPDATE entities SET title = title WHERE type = 'linear_ticket';

-- ─── entity_comments ────────────────────────

CREATE OR REPLACE FUNCTION entity_comments_search_vector_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.author_name, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')),     'A');
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_entity_comments_search_vector ON entity_comments;
CREATE TRIGGER trg_entity_comments_search_vector
  BEFORE INSERT OR UPDATE OF content, author_name ON entity_comments
  FOR EACH ROW
  EXECUTE FUNCTION entity_comments_search_vector_trigger();

-- Force rebuild for existing comments.
UPDATE entity_comments SET content = content;
