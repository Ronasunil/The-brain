# Feature Plan: `/remember` Endpoint

**Date:** 2026-04-21
**Status:** Planning
**Requested by:** User

---

## 1. Feature Overview

Add a single authenticated write endpoint — `POST /api/v1/brain/remember` — that lets an end user persist a short fact (e.g. `"DNS is managed via Cloudflare"`) into the knowledge corpus. The endpoint reuses the existing `MessageService.ingest` pipeline, which writes the row to `messages`, synchronously tries to generate a vector embedding, and — if the inline embedding fails — relies on the already-running background `EmbeddingWorker` to backfill it.

Retrieval is *not* a new surface: because the row lives in the same `messages` table that `/brain/ask` already queries (hybrid semantic + full-text search over all messages in a workspace), the remembered fact is immediately discoverable through `/brain/ask` once embedded.

**Scope is deliberately minimal**: no new table, no migration, no new dependency, no new service layer. One endpoint, ~50 lines of additive code across four existing files.

## 2. Acceptance Criteria

- [ ] `POST /api/v1/brain/remember` accepts `{ text: string, workspace_id?: string }` and returns `201` with `{ status: 201, data: RememberedItem, message: "Remembered successfully" }`
- [ ] The `text` field is required, trimmed, min 3 chars, max `MAX_MESSAGE_LENGTH` (4096) chars
- [ ] Missing or invalid JWT cookie → `401 { status: 401, data: null, message: "Authentication required" }`
- [ ] Empty / too-short `text` → `400` with the Zod error message
- [ ] A successful call writes a row to `messages` with `source='manual'`, `source_message_id='remember:<uuid>'`, `user_id=<authed user id>`, `user_name=<authed user name>`, `chat_id='remember:<user id>'`, `chat_name='Remembered notes'`, `content=<text>`, `timestamp=<now>`, and the caller-supplied (or default) `workspace_id`
- [ ] After the request completes, the row is embedded — either inline (logged as `✅ Embedded message …`) or by the next `EmbeddingWorker` sweep
- [ ] A subsequent `POST /api/v1/brain/ask` with a relevant question surfaces the remembered text in `data.sources` with `source="manual"` and the correct `user_name`
- [ ] TypeScript compiles with zero new errors
- [ ] No changes to `/brain/ask`, `/auth/*`, `/import/*`, `/health` behavior
- [ ] No database migration, no new package dependency

## 3. Current Codebase Analysis

### Tech Stack

- **Language:** TypeScript (tsx for dev, tsc for build)
- **Framework:** Express 4.x
- **Database:** Supabase PostgreSQL + pgvector (via `@supabase/supabase-js`)
- **Validation:** zod
- **Auth:** JWT in httpOnly cookie (already shipped — see `PLAN-user-auth-2026-03-29.md`)
- **AI:** pluggable provider (OpenAI / Cohere / Zhipu) via `AIService`

### Project Structure Overview (relevant slice)

```
src/
├── app.ts                                → Express setup, mounts /api/v1
├── config/env.ts                         → Zod-validated env
├── db/
│   ├── client.ts                         → Supabase singleton
│   └── message.repository.ts             → messages table CRUD (create, updateEmbedding, ...)
├── lib/
│   ├── constants/app.constants.ts        → DEFAULT_WORKSPACE_ID, MAX_MESSAGE_LENGTH
│   ├── errors/{app-error,error-handler}.ts
│   ├── middleware/
│   │   ├── auth.middleware.ts            → authenticate (JWT cookie → req.user)
│   │   ├── validate-body.ts              → validateBody(schema) → req.validatedBody
│   │   └── index.ts                      → barrel: { validateBody, authenticate }
│   ├── types/
│   │   ├── message.types.ts              → MESSAGE_SOURCES, StoredMessage, CreateMessageInput
│   │   ├── auth.types.ts                 → AuthenticatedRequest, UserResponse
│   │   └── index.ts                      → barrel
│   └── validations/
│       └── brain.schema.ts               → askQuestionSchema (sibling for rememberSchema)
├── routes/
│   ├── main.route.ts                     → mounts /brain, /auth, /import, /health
│   └── brain.route.ts                    → POST /ask (inline handler; /remember goes here too)
└── services/
    ├── message.service.ts                → MessageService.ingest (store + embed + log-on-fail)
    ├── embedding.worker.ts               → background sweep over rows with embedding IS NULL
    └── query.service.ts                  → /ask retrieval (hybrid semantic + full-text)
```

### Relevant Existing Code

| File | Purpose | Relevance to feature |
| --- | --- | --- |
| `src/routes/brain.route.ts` | Currently defines `POST /ask` inline | Add `POST /remember` handler alongside `/ask` in the same file |
| `src/services/message.service.ts` | `MessageService.ingest(input)`: store → embed → log-on-fail | Called by the new handler — zero changes |
| `src/db/message.repository.ts` | `messages` table CRUD; `create` is idempotent on `(source, source_message_id)` | Used transitively via `MessageService.ingest` |
| `src/services/embedding.worker.ts` | Runs on interval, re-embeds rows with `embedding IS NULL` | Safety net if inline embedding fails; zero changes |
| `src/lib/validations/brain.schema.ts` | Currently holds `askQuestionSchema` | Add `rememberSchema` + `RememberPayload` type |
| `src/lib/middleware/auth.middleware.ts` | `authenticate` — JWT cookie → `req.user: UserResponse` | Chained on the new route |
| `src/lib/middleware/index.ts` | Middleware barrel | Already exports `authenticate` — no change |
| `src/lib/middleware/validate-body.ts` | `validateBody(schema)` — puts parsed body on `(req as any).validatedBody`, throws `AppError(400)` | Chained on the new route |
| `src/lib/errors/error-handler.ts` | `withErrorHandler` — catches thrown `AppError`/unknown errors | Wraps the new handler |
| `src/lib/constants/app.constants.ts` | `DEFAULT_WORKSPACE_ID = "default"`, `MAX_MESSAGE_LENGTH = 4096` | Imported by schema + route |
| `src/lib/types/message.types.ts` | `MESSAGE_SOURCES` already includes `"manual"`; defines `StoredMessage`, `CreateMessageInput` | Add `RememberedItem` response type |
| `src/lib/types/index.ts` | Types barrel | Re-export `RememberedItem` |
| `src/lib/types/auth.types.ts` | `AuthenticatedRequest`, `UserResponse` | Imported by the new handler |
| `src/routes/main.route.ts` | Mounts sub-routers at `/brain`, `/auth`, etc. | **No change** — `/remember` lives under the already-mounted `brainRouter` |

## 4. Impact & Breakpoint Analysis

### What Will Break (or Not)

| Area | Risk Level | Description | Mitigation |
| --- | --- | --- | --- |
| `src/routes/brain.route.ts` | 🟢 Low | Adding a second route in the same file; handler is additive | Follow the existing `/ask` style exactly (inline handler, `validateBody` + `withErrorHandler`) |
| `src/lib/validations/brain.schema.ts` | 🟢 Low | Adding a sibling Zod schema | New `rememberSchema` is independent of `askQuestionSchema` |
| `src/lib/types/message.types.ts` | 🟢 Low | Adding an additional exported interface | No changes to existing types |
| `src/lib/types/index.ts` | 🟢 Low | One re-export line | No cascading effects |
| `/brain/ask` behavior | ✅ No Impact | The query service already searches all messages in the workspace, including `source='manual'` rows | N/A — new remembered rows simply become additional candidates |
| `MessageService.ingest` | ✅ No Impact | Consumed as-is | N/A |
| Auth flow | ✅ No Impact | `authenticate` middleware consumed as-is | N/A |
| `messages` schema / DB | ✅ No Impact | Reuses existing columns and the `"manual"` enum value | No migration |

### Database Impact

- **Schema changes needed?** No
- **Migration required?** No
- **Data backfill needed?** No
- **New data written:** Additional rows in `messages` with `source='manual'` and `source_message_id` prefixed `remember:`

### API Impact

- **New endpoints:**
  - `POST /api/v1/brain/remember` (protected)
- **Modified endpoints:** None
- **Breaking changes for consumers?** No

### Shared Dependencies

| Dependency | Used By | Modified? |
| --- | --- | --- |
| `MessageService.ingest` | `/import/*`, Telegram ingestion, new `/remember` | No — consumed only |
| `authenticate` middleware | `GET /auth/me`, new `/remember` | No — consumed only |
| `withErrorHandler` | all routes | No — consumed only |
| `validateBody` | `/ask`, `/auth/*`, `/import/*`, new `/remember` | No — consumed only |
| `DEFAULT_WORKSPACE_ID` | `/ask`, new `/remember` | No — consumed only |
| `MAX_MESSAGE_LENGTH` | (previously unused in validation) new `rememberSchema` | No — consumed only |

### Design decisions

| Decision | Choice | Reasoning |
| --- | --- | --- |
| Path & mount | `POST /api/v1/brain/remember` on `brainRouter` | Remember and ask are two halves of the same knowledge feature; co-location avoids a new top-level router for one endpoint. |
| Auth policy | Require `authenticate` | We need `user_id`/`user_name` on the stored row for correct attribution in `/ask` source citations; writes deserve stricter protection than reads (`/ask` stays open). Asymmetry is intentional. |
| `source` value | `"manual"` (already in `MESSAGE_SOURCES`) | Already wired end-to-end; adding a new enum value would require touching constants, types, and any source-switching code for no semantic gain. |
| `source_message_id` | `` `remember:${randomUUID()}` `` | Unique per call (required by `UNIQUE(source, source_message_id)`), human-readable during debugging, collision-free vs. numeric IDs used by other sources. `randomUUID` from `node:crypto` — no dep. |
| `workspace_id` default | `DEFAULT_WORKSPACE_ID` if body omits it | Mirrors `/ask` (`src/routes/brain.route.ts:22`). |
| `chat_id` | `` `remember:${user.id}` `` (stable per user) | Free forward-compat: a future "list my remembered items" endpoint can filter on this without a schema change. Zero cost today. |
| `chat_name` | `"Remembered notes"` | Human-readable placeholder. Not surfaced in `BrainAnswer.sources` (not part of that shape), so no user-visible effect. |
| `timestamp` | `new Date()` server-side | The moment the call was made. |
| Handler placement | Inline in `brain.route.ts` (match `/ask`) | A `BrainController` object would be premature for two handlers. Revisit if the file grows past ~4 routes. |
| Response shape | Curated `RememberedItem` (`id`, `content`, `timestamp`, `created_at`) | Returning raw `StoredMessage` exposes `embedding: null` (the service updates the DB row but not the returned object) and internal bookkeeping (`source_message_id`, `chat_id`, …). Curation matches the existing `UserRecord → UserResponse` pattern. |
| HTTP status | `201 Created` | A resource was created. Matches `AuthController.signup`. |
| Idempotency | None (each call creates a row) | A user saying the same fact twice is two legitimate events. Content-hash dedupe adds schema + surprise behavior for no v1 benefit. |
| Embedding strategy | Delegate to `MessageService.ingest` | Inline attempt, log-and-continue on failure, background worker as safety net — all already built. |

## 5. Implementation Plan

### Step 1: Add `rememberSchema` to the brain schema file

- **What:** Append a Zod schema for the request body and export its inferred type.
- **Files:** `src/lib/validations/brain.schema.ts` (modify; ~+10 lines)
- **Dependencies:** None
- **Estimated complexity:** Low
- **Details:**
  ```ts
  import { MAX_MESSAGE_LENGTH } from "../constants/app.constants";

  export const rememberSchema = z.object({
    text: z
      .string()
      .trim()
      .min(3, "text must be at least 3 characters")
      .max(MAX_MESSAGE_LENGTH, `text must be at most ${MAX_MESSAGE_LENGTH} characters`),
    workspace_id: z.string().min(1).optional(),
  });

  export type RememberPayload = z.infer<typeof rememberSchema>;
  ```
  `min(3)` mirrors `MessageService.ingest`'s own 3-char floor (`src/services/message.service.ts:16`), so we reject at the HTTP layer rather than letting the service throw a raw `Error` that would surface as a `500` through `withErrorHandler`.

### Step 2: Add `RememberedItem` response type

- **What:** Add a curated response shape so the handler can return a clean object without `embedding`/`source_message_id`/`chat_id`/etc.
- **Files:** `src/lib/types/message.types.ts` (modify; ~+7 lines)
- **Dependencies:** None
- **Estimated complexity:** Low
- **Details:**
  ```ts
  export interface RememberedItem {
    id: string;
    content: string;
    timestamp: Date;
    created_at: Date;
  }
  ```

### Step 3: Re-export `RememberedItem` from the types barrel

- **What:** One line so the route file can import it from `../lib/types`.
- **Files:** `src/lib/types/index.ts` (modify; +1 line)
- **Dependencies:** Step 2
- **Estimated complexity:** Low

### Step 4: Add the route handler in `brain.route.ts`

- **What:** Add `router.post("/remember", authenticate as any, validateBody(rememberSchema), withErrorHandler(...))` alongside the existing `/ask` route.
- **Files:** `src/routes/brain.route.ts` (modify; ~+30 lines including imports)
- **Dependencies:** Steps 1, 2, 3
- **Estimated complexity:** Low
- **Required new imports in the file:**
  - `randomUUID` from `node:crypto`
  - `authenticate` from `../lib/middleware`
  - `MessageService` from `../services/message.service`
  - `rememberSchema` from `../lib/validations/brain.schema`
  - `AuthenticatedRequest` from `../lib/types/auth.types`
  - `RememberedItem` from `../lib/types`
- **Handler:**
  ```ts
  router.post(
    "/remember",
    authenticate as any,
    validateBody(rememberSchema),
    withErrorHandler(async (req: Request, res: Response) => {
      const { text, workspace_id } = (req as any).validatedBody;
      const user = (req as AuthenticatedRequest).user;

      const stored = await MessageService.ingest({
        workspace_id: workspace_id || DEFAULT_WORKSPACE_ID,
        source: "manual",
        source_message_id: `remember:${randomUUID()}`,
        user_name: user.name,
        user_id: user.id,
        chat_id: `remember:${user.id}`,
        chat_name: "Remembered notes",
        content: text,
        timestamp: new Date(),
      });

      const body: RememberedItem = {
        id: stored.id,
        content: stored.content,
        timestamp: stored.timestamp,
        created_at: stored.created_at,
      };

      res.status(201).json({
        status: 201,
        data: body,
        message: "Remembered successfully",
      });
    }),
  );
  ```
- **Middleware ordering rationale:** `authenticate` runs before `validateBody`. An anonymous caller with a bad body therefore gets a `401` without learning the body schema; a validated caller then gets a proper `400` on bad input. Same convention as `GET /auth/me`.

### Step 5: Typecheck

- **What:** Run the TypeScript compiler to catch any import / type issues.
- **Files:** none
- **Dependencies:** Steps 1–4
- **Estimated complexity:** Low
- **Command:** `npm run build` (or `npx tsc --noEmit`)

### Step 6: Manual end-to-end verification

See Section 6.

## 6. Verification / Test Plan

Assumes `npm run dev` on `localhost:3000` and a valid `.env` (`JWT_SECRET`, Supabase creds, `AI_PROVIDER` with matching key). Use a cookie jar to persist the JWT.

```bash
# 1. Signup — also sets the auth cookie
curl -s -c /tmp/brain.cookies -X POST http://localhost:3000/api/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Rona","email":"rona+remember@example.com","username":"rona_rem","password":"hunter2hunter2"}'
# Expect: { status: 201, data: { id, email, name, ... }, message: "User created successfully" }

# 2. Remember — happy path
curl -s -b /tmp/brain.cookies -X POST http://localhost:3000/api/v1/brain/remember \
  -H "Content-Type: application/json" \
  -d '{"text":"DNS is managed via Cloudflare"}'
# Expect: { status: 201,
#           data: { id: "<uuid>", content: "DNS is managed via Cloudflare", timestamp: "...", created_at: "..." },
#           message: "Remembered successfully" }
# Server log: "✅ Embedded message <id> from manual"

# 3. Auth failure — no cookie
curl -s -X POST http://localhost:3000/api/v1/brain/remember \
  -H "Content-Type: application/json" \
  -d '{"text":"should be rejected"}'
# Expect: { status: 401, data: null, message: "Authentication required" }

# 4. Validation failure — too short
curl -s -b /tmp/brain.cookies -X POST http://localhost:3000/api/v1/brain/remember \
  -H "Content-Type: application/json" \
  -d '{"text":"hi"}'
# Expect: { status: 400, data: null, message: "text must be at least 3 characters" }

# 5. Retrieval — confirm the fact is queryable through the existing /ask endpoint
curl -s -X POST http://localhost:3000/api/v1/brain/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"How is our DNS managed?"}'
# Expect: 200; data.answer mentions Cloudflare; data.sources contains the remembered text
#         with source="manual" and user_name="Rona".
```

If Step 5 fails to cite the fact:
- Most common cause: the inline embedding in `MessageService.ingest` failed (check server logs for `⚠️ Failed to embed`). The `EmbeddingWorker` will sweep it on the next tick — wait `EMBEDDING_WORKER_INTERVAL_MS` and retry Step 5.
- Less common: `AI_PROVIDER` / API key misconfiguration in `.env` (inspect `src/config/env.ts` for the enabled provider's expected vars).

DB-level spot check (optional, Supabase SQL editor):
```sql
select id, source, source_message_id, user_name, content, timestamp,
       embedding is null as needs_embed
from messages
where source = 'manual' and source_message_id like 'remember:%'
order by created_at desc
limit 5;
```

## 7. Out of Scope / Follow-ups

- `GET /brain/remembered` list endpoint (the `chat_id = 'remember:<user_id>'` convention above makes this a one-query addition later)
- `DELETE /brain/remembered/:id`
- Tags / categories on remembered items
- Rate limiting
- Dedupe on identical `(user, text)` pairs
- Workspace membership enforcement — any authenticated user can currently write to any `workspace_id` (matches the rest of the codebase; worth its own ticket)
- Putting `/brain/ask` behind `authenticate` for symmetry with `/remember`

---

## Summary

Four additive edits to existing files (`brain.schema.ts`, `message.types.ts`, `types/index.ts`, `brain.route.ts`). No new packages, no migrations, no new services. Total code delta ≈ 50 lines. The endpoint reuses the existing, tested ingestion pipeline, so remembered text is automatically embedded and immediately retrievable through `/brain/ask`.
