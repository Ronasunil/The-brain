# Progress PRD: Linear Integration — Platform Knowledge for The Brain

**Date:** 2026-04-23
**Status:** Planning
**Branch:** `rs/linear-integration`
**Requested by:** User

---

## 1. Feature Overview

The Brain currently ingests chat-shaped events (Telegram) into a single `messages` table. Linear is the first "non-chat" source: its content is structured, mutable, and state-driven (status, priority, assignee, cycle). Forcing tickets through `messages` would corrupt retrieval ("closed 4 months ago" ranking as "open right now") and blow up embedding cost (state changes re-embedding unchanged text).

This PRD introduces a second first-class shape — **entities** — alongside `messages`. An entity is a mutable thing (Linear ticket, later GitHub PR, Notion page, Jira epic) with live state, a markdown body, threaded comments, and cross-source links. The migration creates three new tables (`entities`, `entity_comments`, `entity_links`), a set of partial and composite indexes tuned for the actual query patterns, and reusable Postgres RPCs for hybrid search over entities.

Linear is wired as the first consumer: OAuth connect, webhook subscription for `Issue`/`Comment`/`IssueLabel`/`Project`/`Cycle` events, background backfill via GraphQL pagination, and an event router that splits state-only updates (no embedding cost) from content updates (re-embed + content-hash dedup). Queries are routed: structural signals (`P0`, `@me`, ticket ID, `open`) → SQL on `entities.state`; semantic questions → embedding search; mixed → both with provenance-tagged merging.

All embeddings in this project are **1024-dim** because Cohere (`embed-english-v3.0`) is the primary provider and caps at 1024. OpenAI and Zhipu providers are configured to emit 1024 too (`AI_PROVIDER_CONFIGS` in `app.constants.ts`). The new `entities` and `entity_comments` tables use `VECTOR(1024)` with a `CHECK` constraint so the dim can't regress.

---

## 2. Acceptance Criteria

### Connection & setup

- [ ] `POST /api/v1/integrations/linear/connect` returns Linear OAuth URL with `state` param
- [ ] `GET /api/v1/integrations/linear/callback?code=&state=` exchanges for access+refresh token, encrypts both (`encrypt()` from `lib/utils/encryption`), stores in `integrations.config`
- [ ] On successful OAuth, row in `integrations` has `type='linear'`, `status='pending'`, `workspace_id=<caller>`, `webhook_secret=<32-byte hex>`, `config={linear_org_id, access_token_ciphertext, refresh_token_ciphertext, scope}`
- [ ] Post-OAuth, webhook is registered with Linear via `Webhook.create` mutation; integration flips to `status='active'`
- [ ] Backfill job enqueues on activation, paginates 50 issues/page, respects Linear 1500 req/hr rate limit, persists `config.backfill_cursor`, sets `config.backfill_complete=true` when done
- [ ] `GET /api/v1/integrations/linear/:id/status` returns `{ backfill: { cursor, complete, total_synced }, last_webhook_at, last_error }`

### Webhook ingestion

- [ ] `POST /api/v1/linear/webhook/:integrationId` verifies HMAC-SHA256 of raw body against `integrations.webhook_secret`; rejects with 401 if invalid
- [ ] Handler returns 200 in <100ms (measured at p99 on a warm process); processing is enqueued, not inline
- [ ] `Issue` create → new row in `entities`, embedding enqueued to worker
- [ ] `Issue` update where `title`/`description` changed → `content_hash` compared; if different, re-embed; if same, only `state` + `external_updated_at` updated
- [ ] `Issue` update with ONLY `state`/`assignee`/`priority`/`label` change → zero embedding calls, single UPDATE to `entities.state`
- [ ] `Issue` remove OR `archivedAt IS NOT NULL` → entity deleted, comments cascade, links cascade
- [ ] `Comment` create → new row in `entity_comments`, embedding enqueued
- [ ] `Comment` remove → row deleted
- [ ] Replayed webhook (same `external_updated_at`) is a no-op (idempotent)
- [ ] Stale-write protection: incoming write with `external_updated_at <= entities.external_updated_at` is dropped

### Query correctness

- [ ] `POST /api/v1/brain/ask` with question matching a ticket returns the ticket with `source.type='linear_ticket'`, `source.external_id='ENG-423'`, `source.external_url=<link>`, `source.state.status=<current>`
- [ ] Question with structural signals (`open`, `P0`, ticket ID regex `[A-Z]{2,}-\d+`, `@me`, `this cycle`) routes to SQL-only path (zero embedding cost, zero Cohere cost); p95 latency < 150ms
- [ ] Semantic question hits the hybrid path; results include state tags in the AI prompt; AI system prompt enforces "closed/cancelled tickets are historical"
- [ ] When retrieved top-1 similarity < `MIN_SIMILARITY_THRESHOLD` (0.3), response is explicit: "I don't have anything synced that matches that" — no fabricated answer
- [ ] Answers referencing a Linear ticket include `[linear-ENG-423]` source tags; post-processor strips any sentence whose tag doesn't appear in retrieved context
- [ ] Cross-tenant isolation: two workspaces with similar content produce zero cross-workspace leak (enforced at repository signature + integration test)

### Performance budgets

- [ ] Webhook endpoint: p99 < 100ms, p50 < 30ms
- [ ] Backfill: 10k tickets complete within 25 minutes on Linear's default rate limit
- [ ] Embedding worker: sustains 50 embeddings/5s against the queue, zero drops
- [ ] `entities` INSERT: p99 < 8ms including all index updates
- [ ] `entities` state-only UPDATE: p99 < 4ms (no TSVECTOR or vector index writes)
- [ ] "Open P0 in Backend" SQL query on 100k tickets: p99 < 50ms

### Vector dim invariant

- [ ] New tables `entities` and `entity_comments` use `VECTOR(1024)` (matching existing Cohere 1024-dim pipeline)
- [ ] Both tables have `CHECK (embedding IS NULL OR vector_dims(embedding) = 1024)` so the dim can't regress
- [ ] IVFFlat indexes built against `VECTOR(1024)` on both new tables

### Out of scope (v2)

- Write-back (create/update Linear tickets from the brain)
- Per-user ACL mirroring of Linear team/project visibility (workspace = visibility boundary in v1)
- GitHub / Notion / Jira ingestion (entities shape supports them, but no provider code)
- Auto-linking engine (PR → ticket, Slack → ticket) — `entity_links` table ships, population is v2
- Linear custom views, saved filters, reactions, attachments

---

## 3. Current Codebase Analysis

### Relevant existing files

| File | Current purpose | Change |
|---|---|---|
| `src/db/migrations/004_integrations.sql` | `integrations` table, includes `'linear'` in type enum, `'legacy-linear-default'` backfilled | No change — already accepts Linear |
| `src/lib/types/integration.types.ts` | `INTEGRATION_TYPES` already includes `'linear'` | No change |
| `src/services/integration.service.ts` | Telegram-specific (`createTelegram`, `getDecryptedToken`) | Add `createLinear`, generalize `getDecryptedToken` to handle OAuth access+refresh |
| `src/services/embedding.worker.ts` | Polls `messages WHERE embedding IS NULL` | Extend: also poll `entities`, `entity_comments` |
| `src/services/query.service.ts` | Hybrid search over `messages` only | Extend: include `entities` and `entity_comments` in parallel fan-out, add query router |
| `src/providers/` | OpenAI/Cohere/Zhipu, all configured to 1024 dims | No change — already correct |

### What's missing entirely

- Linear GraphQL provider (`src/providers/linear.provider.ts`)
- Linear OAuth handler + webhook controller
- `entities`, `entity_comments`, `entity_links` tables, repositories, services
- Query router (structural vs semantic detection)
- Stale-write guard, content-hash dedup, idempotent webhook de-dup
- Vector dim `CHECK` constraints

---

## 4. Architecture & Data Model

### Layered architecture (unchanged from project convention)

```
Route → Controller → Service → Repository → Supabase
```

New modules slot in:

```
src/
├── controllers/linear.controller.ts      ← OAuth callback + webhook endpoint
├── services/
│   ├── linear.service.ts                 ← backfill, event router, stale-write guard
│   └── entity.service.ts                 ← generic entity CRUD (reusable for github/notion later)
├── db/
│   ├── entity.repository.ts              ← entities + entity_comments + entity_links
│   └── migrations/005_entities.sql       ← this PRD
├── providers/linear.provider.ts          ← GraphQL client, OAuth, rate-limiter
├── lib/
│   ├── types/entity.types.ts
│   ├── validations/linear.schema.ts
│   └── constants/linear.constants.ts
├── routes/linear.route.ts
└── services/query-router.ts              ← structural-vs-semantic dispatcher
```

### Data model — three tables, one graph

```
┌──────────────────────────────────────────┐
│ entities                                 │
│ ─────────────────────────────────────── │
│ id                 TEXT PK               │
│ workspace_id       TEXT FK → workspaces  │
│ integration_id     TEXT FK → integrations│
│ type               TEXT                  │
│ external_id        TEXT                  │ ← "ENG-423"
│ external_url       TEXT                  │
│ title              TEXT                  │
│ body               TEXT                  │
│ state              JSONB                 │ ← status, priority, assignee, cycle, labels
│ participants       JSONB                 │ ← [{id,name,role}]
│ content_hash       TEXT                  │ ← sha256(title+body), skip re-embed
│ external_created_at TIMESTAMPTZ          │
│ external_updated_at TIMESTAMPTZ          │ ← optimistic concurrency key
│ embedding          VECTOR(1024)          │
│ search_vector      TSVECTOR              │
│ created_at, updated_at TIMESTAMPTZ       │
└──────────────────────────────────────────┘
         │ 1:N                       │ 1:N
         ▼                           ▼
┌────────────────────┐   ┌──────────────────────┐
│ entity_comments    │   │ entity_links         │
│ ────────────────── │   │ ──────────────────── │
│ id TEXT PK         │   │ from_entity_id FK    │
│ entity_id FK       │   │ to_entity_id FK      │
│ workspace_id       │   │ kind TEXT            │ ← 'mentions'|'closes'|'blocks'
│ external_id        │   │ confidence FLOAT     │ ← 1.0 explicit, <1 inferred
│ author_id, name    │   │ detected_at          │
│ content            │   │ PK (from_id, to_id, kind) │
│ embedding V(1024)  │   └──────────────────────┘
│ search_vector      │
│ created_at         │
└────────────────────┘
```

### Why separate from `messages`?

| Concern | `messages` (chat-shaped) | `entities` (state-shaped) |
|---|---|---|
| Mutation | Immutable events | Mutable state machine |
| Primary identity | `(source, source_message_id)` | `(integration_id, external_id)` |
| Query pattern | Time-range + semantic | State filter + semantic |
| Typical update rate | 0 (append-only) | High (status flips, reassigns) |
| Embedding cadence | Once on insert | Only when content changes (hash-gated) |

Stuffing tickets into `messages` would force either (a) UPDATE on an immutable table, or (b) one "message" per state change, blowing up row count and retrieval noise.

---

## 5. Migration SQL (`005_entities.sql`)

All embeddings are `VECTOR(1024)` to match the existing Cohere-based pipeline (`embed-english-v3.0`, which caps at 1024). `CHECK` constraints pin the dim on both new tables so future providers can't drift.

```sql
-- ============================================
-- Migration 005: entities + entity_comments + entity_links
-- Run this in Supabase SQL Editor AFTER 004.
-- ============================================

-- ─── Part 1: entities table ─────────────────

CREATE TABLE IF NOT EXISTS entities (
  id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id       TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN (
    'linear_ticket','github_issue','github_pr','notion_page','jira_issue'
  )),
  external_id          TEXT NOT NULL,                      -- "ENG-423"
  external_url         TEXT NOT NULL,
  title                TEXT NOT NULL DEFAULT '',
  body                 TEXT NOT NULL DEFAULT '',
  state                JSONB NOT NULL DEFAULT '{}'::jsonb, -- {status, priority, assignee_id, cycle_id, labels[], project_id, estimate}
  participants         JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{id, name, role}]
  content_hash         TEXT NOT NULL DEFAULT '',           -- sha256(title || '\n' || body)
  external_created_at  TIMESTAMPTZ NOT NULL,
  external_updated_at  TIMESTAMPTZ NOT NULL,
  embedding            VECTOR(1024),
  search_vector        TSVECTOR,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

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

-- Auto-populate search_vector on insert/update of title or body.
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

-- ─── Part 2: entity_comments ───────────────

CREATE TABLE IF NOT EXISTS entity_comments (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  entity_id         TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_id       TEXT NOT NULL,
  author_id         TEXT NOT NULL DEFAULT '',
  author_name       TEXT NOT NULL DEFAULT 'unknown',
  content           TEXT NOT NULL,
  embedding         VECTOR(1024),
  search_vector     TSVECTOR,
  external_created_at TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

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
```

---

## 6. Index Strategy — Fast Reads, Honest Write Cost

Every index slows writes. The rule used below: **index the query, not the column.** Partial indexes keep write cost off the cold path (closed/archived tickets); expression indexes avoid the full JSONB GIN overhead when we only filter on a few known keys.

### `entities` — indexes and their purpose

```sql
-- Ownership + tenancy scope (covers EVERY query — always in WHERE)
CREATE INDEX idx_entities_workspace_integration_type
  ON entities (workspace_id, integration_id, type);

-- Recency sort (dashboards, "recently updated")
CREATE INDEX idx_entities_workspace_updated
  ON entities (workspace_id, external_updated_at DESC);

-- Semantic search
CREATE INDEX idx_entities_embedding
  ON entities
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Full-text search
CREATE INDEX idx_entities_search_vector
  ON entities USING gin (search_vector);

-- Hot path: "open tickets assigned to X" — PARTIAL index keeps closed rows out.
-- Expression index on JSONB keys avoids the overhead of a general GIN on `state`.
CREATE INDEX idx_entities_open_by_assignee
  ON entities (workspace_id, (state->>'assignee_id'))
  WHERE type = 'linear_ticket'
    AND state->>'status' IN ('backlog','unstarted','started');

-- Hot path: "open by priority" — again partial.
CREATE INDEX idx_entities_open_by_priority
  ON entities (workspace_id, (state->>'priority')::int)
  WHERE type = 'linear_ticket'
    AND state->>'status' IN ('backlog','unstarted','started');

-- Cycle scoping: "what's in the current cycle"
CREATE INDEX idx_entities_cycle
  ON entities (workspace_id, (state->>'cycle_id'))
  WHERE type = 'linear_ticket'
    AND state->>'cycle_id' IS NOT NULL;

-- Fallback GIN on state JSONB for the long tail (rare label filters, ad-hoc).
-- Moderate write cost; consider dropping if load profile says it's unused.
CREATE INDEX idx_entities_state_gin
  ON entities USING gin (state jsonb_path_ops);

-- Content-hash lookup for upsert path (compare before re-embed)
CREATE INDEX idx_entities_content_hash
  ON entities (integration_id, content_hash);
```

### `entity_comments` — indexes

```sql
-- Fan-out by parent ticket (most common join)
CREATE INDEX idx_entity_comments_entity
  ON entity_comments (entity_id, external_created_at DESC);

-- Tenancy scope (also for cross-tenant queries filtered on workspace)
CREATE INDEX idx_entity_comments_workspace
  ON entity_comments (workspace_id, external_created_at DESC);

-- Semantic search per workspace
CREATE INDEX idx_entity_comments_embedding
  ON entity_comments
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Full-text
CREATE INDEX idx_entity_comments_search_vector
  ON entity_comments USING gin (search_vector);

-- Author filter ("what did @ron say about...")
CREATE INDEX idx_entity_comments_author
  ON entity_comments (workspace_id, author_id);
```

### `entity_links` — indexes

```sql
-- Graph traversal: "what links to ENG-423"
CREATE INDEX idx_entity_links_to
  ON entity_links (to_entity_id, kind);

-- Graph traversal: "what does this PR close" (from-direction is already the PK prefix)
-- PK already covers (from_entity_id, to_entity_id, kind); no extra index needed.
```

### Index write-cost summary

| Table | Index count | Per-INSERT overhead (est.) | Per state-only UPDATE overhead |
|---|---|---|---|
| `entities` | 9 | ~0.8ms (4 B-tree, 1 IVFFlat, 1 GIN tsvector, 1 GIN jsonb, 2 partial) | ~0.3ms (only 3 partial indexes on the updated column are re-evaluated, ivfflat + gin + tsvector untouched) |
| `entity_comments` | 5 | ~0.5ms | N/A (comments are append-only) |
| `entity_links` | 2 | ~0.1ms | N/A |

The partial indexes matter: a typical workspace will have 60-80% of tickets in `Done` or `Cancelled` state. Those rows get ~4 fewer index writes each than they would with non-partial indexes.

---

## 7. Ingestion Flow

### OAuth + webhook registration

```
POST /api/v1/integrations/linear/connect  (authenticated, workspace-scoped)
  → returns 302 to https://linear.app/oauth/authorize?client_id=...&state=<signed>

GET /api/v1/integrations/linear/callback?code=<>&state=<>
  → verify state signature (HMAC, 5-min TTL)
  → exchange code for access_token + refresh_token
  → INSERT INTO integrations (status='pending', config={access_token_ciphertext, ...})
  → POST to Linear GraphQL: webhookCreate(url=/api/v1/linear/webhook/:id, secret=<webhook_secret>)
  → UPDATE integrations SET status='active'
  → enqueue backfill job
  → redirect user to dashboard
```

### Backfill (background, rate-limited)

```
Loop while !config.backfill_complete:
  page = Linear.issues(first=50, after=config.backfill_cursor, orderBy=updatedAt_asc)
  for ticket in page.nodes:
    entity.service.upsertFromLinear(ticket, integration)
    # upsert = INSERT ... ON CONFLICT (integration_id, external_id) DO UPDATE
    #          SET ... WHERE entities.external_updated_at < EXCLUDED.external_updated_at
    # (stale-write guard)
    enqueue embedding job if content_hash changed
  config.backfill_cursor = page.endCursor
  if !page.hasNextPage: config.backfill_complete = true
  sleep_for_rate_limit()  # Linear: 1500 req/hr burst-safe = 2.4s between pages
```

### Webhook handler (< 100ms budget)

```ts
// src/controllers/linear.controller.ts
static webhook = asyncHandler(async (req, res) => {
  const { integrationId } = req.params;
  const raw = req.rawBody;  // capture via express.raw middleware on this route
  const sig = req.header("linear-signature");

  // Step 1: verify HMAC (constant-time compare)
  const integration = await IntegrationRepository.findById(integrationId);
  if (!integration) throw new AppError("Unknown integration", 404);
  if (!verifyHmac(raw, sig, integration.webhook_secret)) {
    throw new AppError("Invalid signature", 401);
  }

  // Step 2: parse + enqueue. DO NOT PROCESS INLINE.
  const event = LinearWebhookEvent.parse(JSON.parse(raw.toString()));
  await LinearEventQueue.enqueue({ integrationId, event });

  // Step 3: 200 fast
  res.status(200).json({ status: 200, data: null, message: "queued" });
});
```

### Event router (worker side)

```ts
// src/services/linear.service.ts
async function processEvent(integrationId, event) {
  if (event.type === "Issue" && event.action === "create") {
    return ingestTicket(event.data, integrationId);
  }
  if (event.type === "Issue" && event.action === "update") {
    const changed = Object.keys(event.updatedFrom ?? {});
    const isContent = changed.includes("title") || changed.includes("description");
    return isContent
      ? ingestTicket(event.data, integrationId)        // re-embed path
      : updateStateOnly(event.data, integrationId);    // no embed
  }
  if (event.type === "Issue" && event.action === "remove") {
    return deleteEntity(event.data.identifier, integrationId);
  }
  if (event.type === "Comment") {
    return handleComment(event);
  }
  // IssueLabel, Project, Cycle, Reaction — update entity.state accordingly
}
```

`ingestTicket` computes `content_hash = sha256(title + '\n' + body)` and skips the embedding path if the existing row's hash matches. `updateStateOnly` is a single UPDATE that touches only the JSONB + `external_updated_at` — zero index writes to vector/tsvector/partial indexes that don't depend on those columns.

### Stale-write guard (optimistic concurrency)

Every UPDATE uses:

```sql
UPDATE entities SET ... WHERE id = $1 AND external_updated_at <= $2
```

Backfill paging an old page while a webhook delivers a new edit cannot overwrite fresher state. The row count returned is `0` → write silently dropped → idempotent.

---

## 8. Query Path — Router + Correctness

### Query router

```ts
// src/services/query-router.ts
function classifyQuestion(q: string): "structural" | "semantic" | "hybrid" {
  const hasTicketId  = /\b[A-Z]{2,}-\d+\b/.test(q);
  const hasStatus    = /\b(open|closed|done|in progress|todo|cancelled|blocked)\b/i.test(q);
  const hasPriority  = /\bP[0-4]\b|\b(urgent|high|medium|low)\b/i.test(q);
  const hasAssignee  = /\b(@\w+|assigned to me|my tickets)\b/i.test(q);
  const hasCycle     = /\b(this cycle|current sprint|last cycle)\b/i.test(q);

  const structural = [hasTicketId, hasStatus, hasPriority, hasAssignee, hasCycle]
    .filter(Boolean).length;

  if (structural >= 2 || hasTicketId) return "structural";
  if (structural === 1)               return "hybrid";
  return "semantic";
}
```

| Class | Path | Cost per query | p95 latency target |
|---|---|---|---|
| structural | SQL on `entities.state`, zero embeddings, zero rerank | 1 SELECT | < 50ms |
| semantic | Embed question → hybrid cosine + FTS → rerank → AI | 1 embed + 3 parallel SQL + 1 Cohere rerank + 1 LLM call | < 2s |
| hybrid | SQL pre-filter + semantic on filtered set | same as semantic minus broad scan | < 1.5s |

### Correctness guarantees fed to the AI prompt

Every retrieved chunk is wrapped with provenance and state:

```
[linear-ENG-423 | status=Done | closed 2025-11-03 | https://linear.app/.../ENG-423]
Title: Redis cache invalidation on user logout
Body: ...

[linear-ENG-501 | status=In Progress | assignee=@ron | https://linear.app/.../ENG-501]
Title: Fix session TTL
Body: ...
```

Appended to the existing `SYSTEM_PROMPT`:

```
9. For any Linear ticket with status='Done','Cancelled','Duplicate', treat its
   content as historical. If the user asks about current state, say
   "This was resolved on <closed date>." Do NOT describe it in present tense.
10. Every factual claim about a Linear ticket must be followed by its source tag
    in square brackets, e.g. [linear-ENG-423]. If you cannot tag a claim, omit it.
11. If no sources are provided or similarity is below threshold, say you don't
    have the information. Do not use your own training knowledge to fill gaps.
```

Post-processor on the generated answer: regex-extract `[linear-XXX-\d+]` tags; verify each one was actually retrieved; drop any sentence whose tag is not in the retrieval set.

---

## 9. Performance Analysis

### Write-path budgets

| Op | Operations | Est. cost |
|---|---|---|
| New ticket (webhook → processed) | 1 INSERT `entities`, 1 embedding call (~400ms), 1 UPDATE for embedding | 450ms total, webhook returns in ~30ms |
| State-only update | 1 UPDATE `entities` (JSONB + external_updated_at only) | ~4ms, zero embed cost |
| Content edit | 1 UPDATE `entities` + 1 embedding (if hash changed) | ~450ms if changed, ~6ms if unchanged |
| New comment | 1 INSERT `entity_comments`, 1 embedding call | ~450ms |
| Delete | 1 DELETE `entities` (cascades to comments + links) | ~8ms |

### Why writes stay fast

1. **Webhook returns 200 in <100ms** because work is queued. Embedding latency is hidden from Linear.
2. **State-only path dodges the expensive indexes.** `entity_embedding`, `entity_search_vector`, and the TSVECTOR trigger are gated on `UPDATE OF title, body` — state updates don't trigger them.
3. **Content-hash dedup** skips ~70% of content-containing updates (real-world: most "update" webhooks are mixed, only a fraction actually change text).
4. **Partial indexes** mean closed tickets (the majority over time) write to fewer indexes than open ones.

### Read-path budgets

| Query | Index used | p95 target | Verified against 100k rows |
|---|---|---|---|
| "ENG-423" | `entities_external_unique` (B-tree) | < 3ms | |
| "my open P1s" | `idx_entities_open_by_assignee` + `idx_entities_open_by_priority` | < 30ms | |
| "what's in this cycle" | `idx_entities_cycle` | < 40ms | |
| "recently updated tickets" | `idx_entities_workspace_updated` | < 20ms | |
| Semantic question | `idx_entities_embedding` + `idx_entities_search_vector` | < 400ms | |
| Graph: "what links to ENG-423" | `idx_entity_links_to` | < 5ms | |

### IVFFlat tuning

`lists = 100` is the default for <100k rows. Above that, retune to `lists = sqrt(N)` and run `VACUUM ANALYZE`. A scheduled VACUUM after backfill finishes is explicitly in the backfill job.

### pgvector search quality vs speed

`SET ivfflat.probes = 10` at session level on semantic queries: ~10x recall improvement vs default of 1, adds ~30ms. The query service sets this per-connection before the SELECT.

---

## 10. API Surface

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/v1/integrations/linear/connect` | `{ workspace_id }` | `{ data: { oauth_url } }` |
| GET | `/api/v1/integrations/linear/callback?code=&state=` | — | 302 to dashboard |
| GET | `/api/v1/integrations/linear/:id/status` | — | `{ data: { backfill, last_webhook_at, last_error } }` |
| POST | `/api/v1/integrations/linear/:id/resync` | — | `{ data: { job_id } }` (force full backfill) |
| DELETE | `/api/v1/integrations/:id` | — | reuses existing disconnect; extend to call Linear `webhookDelete` |
| POST | `/api/v1/linear/webhook/:integrationId` | raw body (HMAC-verified) | `{ status: 200 }` |

`/brain/ask` does not change shape — it gains new sources automatically via `QueryService` extension.

---

## 11. Files to Create / Modify

### New files

```
src/providers/linear.provider.ts                 — GraphQL client, OAuth, rate limiter
src/controllers/linear.controller.ts             — OAuth callback + webhook endpoint
src/services/linear.service.ts                   — backfill, event router, stale-write guard
src/services/entity.service.ts                   — generic entity CRUD
src/services/query-router.ts                     — structural vs semantic classifier
src/db/entity.repository.ts                      — entities + comments + links
src/db/migrations/005_entities.sql
src/lib/types/entity.types.ts                    — Entity, EntityComment, EntityLink, LinearState
src/lib/validations/linear.schema.ts             — webhook payload, OAuth callback, state shape
src/lib/constants/linear.constants.ts            — OAuth URL, scopes, rate limits, cycle detection regexes
src/routes/linear.route.ts                       — OAuth + webhook routes
docs/prds/PRD-linear-integration-2026-04-23.md   — this doc
```

### Modified files

```
src/services/integration.service.ts              — add createLinear(), generalize OAuth token decrypt
src/services/embedding.worker.ts                 — poll entities + entity_comments alongside messages
src/services/query.service.ts                    — integrate query router, add entity sources to fan-out
src/routes/main.route.ts                         — mount linearRouter
src/lib/types/integration.types.ts               — add LinearIntegrationConfig interface
src/config/env.ts                                — add LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_OAUTH_REDIRECT_URI
package.json                                     — add @linear/sdk (or use raw fetch for smaller footprint)
```

---

## 12. Open Questions / Risks

1. **Linear OAuth app registration** — does the team have a Linear OAuth app yet? If not, that's a one-time human step (create in Linear settings, record client_id/secret). Acceptance criteria implicitly requires `.env` entries.
2. **Rate limit on backfill** — Linear's 1500 req/hr is workspace-scoped per-token. A 10k-ticket workspace needs ~200 GraphQL pages = ~26 minutes of paced backfill. Acceptable for v1; flag if larger workspaces onboard.
3. **Webhook order** — Linear does not guarantee strict ordering. The stale-write guard (`external_updated_at` comparison) handles this, but a narrow window exists where a `Comment` webhook arrives before its parent `Issue` webhook. Mitigation: if comment arrives before entity, create a placeholder entity row (status='pending') and let the later Issue webhook fill it in via upsert.
4. **GraphQL schema drift** — Linear does deprecate fields periodically. Pin `@linear/sdk` to a known version; add a nightly integration test that asserts our query shape still compiles against the live schema.
5. **Deletion of "archived" vs "removed"** — Linear distinguishes. Archived tickets are still searchable in Linear UI; removed are permanently gone. V1 choice: treat both as hard-delete from our entities. Revisit if users request archive-awareness.
6. **Write-back in v2** — the `entity_links` table is shipping now but is only populated by user actions later. Not a blocker, just noting: don't build write-back paths that query `entity_links` until the linker is written.

---

## 13. How to Resume

1. **Read this PRD top-to-bottom** before writing code.
2. Create the OAuth app in Linear, store credentials in `.env` (`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_OAUTH_REDIRECT_URI`).
3. Run migration `005_entities.sql` in Supabase SQL Editor. Purely additive — no changes to `messages` or existing data.
4. Build the provider first (`linear.provider.ts`) and unit-test against a saved GraphQL fixture.
5. Build the webhook controller + event queue. Verify HMAC. Confirm 200 returns in <100ms under load (`hey -z 10s -c 50 ...`).
6. Build `entity.service.ts` and `entity.repository.ts`. Add an integration test that exercises the stale-write guard and content-hash dedup.
7. Wire `query-router.ts` into `QueryService`. Confirm the structural path bypasses embeddings with a unit test asserting zero provider calls.
8. Manual end-to-end: connect a test Linear workspace, verify backfill, edit a ticket, watch the webhook fire, ask the brain about it.
9. Before ship: run `VACUUM ANALYZE entities; VACUUM ANALYZE entity_comments;` and rerun the performance budgets from §9 against a seeded 100k-row fixture.
