## OrgBrain Next.js Migration Plan

This document describes how to migrate OrgBrain from the current **Express-only backend** to a **Next.js App Router** app that serves both **UI** and **backend APIs** in a single deployment.

---

## 1. Current architecture (as of V1)

### 1.1 Backend runtime

- Node/Express app started from `src/server.ts`
  - Creates the Express app from `src/app.ts` (helmet, cors, morgan, json, error handler)
  - Starts HTTP server on `env.PORT`
  - Starts Telegram bot via `TelegramBotService.start()` (polling mode)
  - Starts background `EmbeddingWorker` via `EmbeddingWorker.start()` (5-second `setInterval`)
  - Graceful shutdown on SIGINT/SIGTERM

### 1.2 HTTP API surface

Root router: `src/routes/main.route.ts`, mounted at `/api` in `src/app.ts`

| Method | Route | Handler | Service |
|--------|-------|---------|---------|
| GET | `/api/health` | `health.route.ts` | `MessageService.getCount()` |
| POST | `/api/brain/ask` | `brain.route.ts` | `QueryService.ask()` |
| POST | `/api/import/telegram` | `import.route.ts` | `ImportService.importTelegramExport()` |
| POST | `/api/import/codebase` | `import.route.ts` | `CodebaseImportService.importCodebase()` |
| GET | `/api/import/status/:jobId` | `import.route.ts` | Both import services' `getStatus()` |
| GET | `/api/import/codebase-ui` | `import.route.ts` | Inline HTML page |
| GET | `/api/import/browse` | `import.route.ts` | `fs.readdirSync` directory listing |

### 1.3 Data model and RAG flow

**Tables (Supabase / Postgres with pgvector):**

- `workspaces` — multi-tenant isolation (default: "default")
- `messages` — text messages with `embedding VECTOR(1536)` + `search_vector TSVECTOR`
  - Unique on `(source, source_message_id)`
  - RPC: `search_messages()` (cosine), `search_messages_fulltext()` (tsvector)
- `code_chunks` — code chunks with `embedding VECTOR(1024)` + `search_vector TSVECTOR`
  - Unique on `(workspace_id, source_chunk_id)` (SHA256 hash of path+index+content)
  - RPC: `search_code_chunks()` (cosine), `search_code_chunks_fulltext()` (tsvector)

**RAG pipeline (`QueryService.ask`):**

1. Embed question via `AIService.createEmbedding()`
2. Run 4 parallel searches (message vector + fulltext, code vector + fulltext)
3. Merge + deduplicate within each table
4. Unify into single ranked list
5. Optionally rerank via Cohere (fetch 30 → rerank to top 12)
6. Apply context budget (15,000 chars max)
7. Generate answer via `AIService.generateAnswer()` with system prompt
8. Return `BrainAnswer` with sources (messages + code chunks)

### 1.4 Shared modules (no Express dependency — migrate as-is)

| Module | Path | Notes |
|--------|------|-------|
| DB client | `src/db/client.ts` | Supabase singleton via `getSupabaseClient()` |
| Message repo | `src/db/message.repository.ts` | CRUD + vector/fulltext search RPCs |
| Codebase repo | `src/db/codebase.repository.ts` | Same pattern for code_chunks |
| Query service | `src/services/query.service.ts` | Hybrid search + rerank + LLM |
| AI service | `src/services/ai.service.ts` | Provider-agnostic embedding/chat/rerank |
| Message service | `src/services/message.service.ts` | Ingest + inline embedding |
| Import service | `src/services/import.service.ts` | Streaming JSON parse, background via `.then()` |
| Codebase import | `src/services/codebase-import.service.ts` | Walk dir + chunk + batch insert |
| Embedding worker | `src/services/embedding.worker.ts` | `setInterval` loop, 50 items/batch |
| Telegram service | `src/services/telegram.service.ts` | Polling bot + message routing |
| AI providers | `src/providers/` | OpenAI, Cohere (with rerank), Zhipu |
| Types | `src/lib/types/` | All shared type definitions |
| Constants | `src/lib/constants/` | AI configs, search params, import sizes |
| Zod schemas | `src/lib/validations/` | Request validation (brain, import, telegram, codebase) |
| Utilities | `src/lib/utils/` | `file-walker.ts`, `chunker.ts` |
| Env config | `src/config/env.ts` | Zod-validated env with provider keys |

### 1.5 Express-only modules (will be replaced)

| Module | Path | Replacement |
|--------|------|-------------|
| Express app | `src/app.ts` | Next.js built-in server |
| Server entry | `src/server.ts` | `instrumentation.ts` + `next dev` / `next start` |
| Route files | `src/routes/*.ts` | `src/app/api/` route handlers |
| Error handler | `src/lib/errors/error-handler.ts` | `src/lib/api-utils.ts` |
| Body validator | `src/lib/middleware/validate-body.ts` | Inline Zod parse in route handlers |
| Old errors | `src/error/` | Already superseded by `src/lib/errors/` |

---

## 2. Deployment model: self-hosted Node.js

This migration targets **self-hosted Node.js** (local dev, Docker, VPS) — not Vercel serverless. The key difference:

- The Next.js process is **long-running** (same as Express today)
- `setInterval`, in-memory maps, and filesystem access all work normally
- Background workers run via **`instrumentation.ts`** (Next.js server startup hook)
- Telegram bot continues in polling mode (no webhook migration needed for V1)

If serverless deployment is needed later, the doc notes the required changes in Section 6.

---

## 3. Migration: file structure

### Before (Express)
```
src/
  app.ts                          # Express app setup
  server.ts                       # Entry point (start server + workers)
  config/env.ts                   # Zod env validation
  db/
    client.ts
    message.repository.ts
    codebase.repository.ts
    migrations/
  services/
    query.service.ts
    ai.service.ts
    message.service.ts
    import.service.ts
    codebase-import.service.ts
    embedding.worker.ts
    telegram.service.ts
  providers/
    index.ts
    openai.provider.ts
    cohere.provider.ts
    zhipu.provider.ts
  lib/
    types/
    constants/
    errors/
    middleware/                    # Express-only
    validations/
    utils/
  routes/                         # Express-only
    main.route.ts
    brain.route.ts
    health.route.ts
    import.route.ts
```

### After (Next.js App Router)
```
src/
  app/                            # Next.js App Router
    layout.tsx                    # Root layout
    page.tsx                      # Landing page
    brain/
      page.tsx                    # Ask questions UI
    import/
      codebase/
        page.tsx                  # Codebase import UI (was codebase-ui)
    api/
      health/
        route.ts                  # GET /api/health
      brain/
        ask/
          route.ts                # POST /api/brain/ask
      import/
        telegram/
          route.ts                # POST /api/import/telegram
        codebase/
          route.ts                # POST /api/import/codebase
        status/
          [jobId]/
            route.ts              # GET /api/import/status/:jobId
        browse/
          route.ts                # GET /api/import/browse
      telegram/
        webhook/
          route.ts                # POST /api/telegram/webhook (future)
  config/env.ts                   # Keep schema, switch to lazy validated getter
  db/                             # Keep as-is
  services/                       # Keep as-is
  providers/                      # Keep as-is
  lib/
    types/                        # Keep as-is
    constants/                    # Keep as-is
    errors/app-error.ts           # Keep as-is
    validations/                  # Keep as-is
    utils/                        # Keep as-is
    api-utils.ts                  # NEW: NextResponse helpers
src/instrumentation.ts            # NEW: Start workers on server boot (src-dir layout)
next.config.ts                    # NEW: Next.js config
```

**Deleted files:**
- `src/app.ts` (Express setup)
- `src/server.ts` (Express entry)
- `src/routes/` (entire directory)
- `src/lib/middleware/` (Express middleware)
- `src/lib/errors/error-handler.ts` (Express withErrorHandler)
- `src/lib/errors/index.ts` (re-exported Express-only code)
- `src/error/` (old error directory)

---

## 4. Migration: API route conversions

### 4.1 Error handling pattern

**Express (before):**
```typescript
router.post("/ask",
  validateBody(askQuestionSchema),
  withErrorHandler(async (req, res) => {
    const { question } = (req as any).validatedBody;
    const result = await QueryService.ask(question, "default");
    res.json({ status: 200, data: result, message: "OK" });
  })
);
```

**Next.js (after):**
```typescript
// src/lib/api-utils.ts
import { NextResponse } from "next/server";
import { AppError } from "./errors/app-error";

export function success<T>(data: T, message: string, status = 200) {
  return NextResponse.json({ status, data, message }, { status });
}

export function handleError(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      { status: error.statusCode, data: null, message: error.message },
      { status: error.statusCode },
    );
  }
  console.error("Unhandled API error:", error);
  return NextResponse.json(
    { status: 500, data: null, message: "Internal server error" },
    { status: 500 },
  );
}
```

```typescript
// src/app/api/brain/ask/route.ts
import { NextRequest } from "next/server";
import { success, handleError } from "@/lib/api-utils";
import { askQuestionSchema } from "@/lib/validations/brain.schema";
import { QueryService } from "@/services/query.service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/constants/app.constants";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, workspace_id } = askQuestionSchema.parse(body);
    const result = await QueryService.ask(question, workspace_id || DEFAULT_WORKSPACE_ID);
    return success(result, "Answer generated successfully");
  } catch (error) {
    return handleError(error);
  }
}
```

### 4.2 Route mapping (complete)

| Express route | Next.js file | Method |
|--------------|--------------|--------|
| `GET /api/health` | `src/app/api/health/route.ts` | `GET` |
| `POST /api/brain/ask` | `src/app/api/brain/ask/route.ts` | `POST` |
| `POST /api/import/telegram` | `src/app/api/import/telegram/route.ts` | `POST` |
| `POST /api/import/codebase` | `src/app/api/import/codebase/route.ts` | `POST` |
| `GET /api/import/status/:jobId` | `src/app/api/import/status/[jobId]/route.ts` | `GET` |
| `GET /api/import/browse` | `src/app/api/import/browse/route.ts` | `GET` |
| `GET /api/import/codebase-ui` | `src/app/import/codebase/page.tsx` | Page |

---

## 5. Migration: background workers

### 5.1 `instrumentation.ts` (Next.js server startup hook)

Next.js runs `instrumentation.ts` once when the server starts. We use this to boot the
same Telegram bot and embedding worker:

```typescript
// instrumentation.ts (project root)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { TelegramBotService } = await import("@/services/telegram.service");
    const { EmbeddingWorker } = await import("@/services/embedding.worker");

    TelegramBotService.start();
    EmbeddingWorker.start();

    // Graceful shutdown
    const shutdown = () => {
      TelegramBotService.stop();
      EmbeddingWorker.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
```

This gives us the same behavior as the current `server.ts` — workers start once and
run alongside the Next.js HTTP server.

### 5.2 In-memory job tracking

`ImportService` and `CodebaseImportService` both use in-memory `Map<string, Status>` for job tracking. Since the Next.js process is long-running (self-hosted), this works exactly as before. The `GET /api/import/status/[jobId]` route reads from these maps.

---

## 6. Future: serverless considerations

If deploying to Vercel/serverless later, these changes would be needed:

| Component | Problem | Solution |
|-----------|---------|----------|
| `EmbeddingWorker` | `setInterval` dies between requests | Vercel Cron calling `/api/cron/embed` |
| Import jobs | In-memory maps reset | Move status to DB (`import_jobs` table) |
| Telegram bot | Polling needs long-running process | Switch to webhook (`/api/telegram/webhook`) |
| Codebase import | `fs.readFileSync` on server paths | Browser upload or Supabase Storage |
| `stream-json` | Large file streaming may hit timeout | Chunk into smaller API calls from frontend |

These are NOT needed for self-hosted deployment and are excluded from this migration.

---

## 7. Dependency changes

### Remove (Express-specific)
```
express, @types/express, helmet, cors, @types/cors, morgan, @types/morgan
```

### Add (Next.js)
```
next, react, react-dom, @types/react, @types/react-dom
```

### Keep (shared)
```
@supabase/supabase-js, cohere-ai, openai, zod, node-telegram-bot-api,
@types/node-telegram-bot-api, stream-json, @types/stream-json, dotenv,
typescript, @types/node, tsx
```

### Updated scripts
```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "db:migrate": "tsx src/db/migrate.ts"
}
```

---

## 8. Checklist

- [x] Validate current architecture (Section 1)
- [ ] Install Next.js dependencies
- [x] Create `next.config.ts` and update `tsconfig.json`
- [x] Create `src/lib/api-utils.ts`
- [x] Create root layout and landing page
- [x] Port all 6 API routes to `src/app/api/`
- [x] Create React UI pages (codebase import, brain ask)
- [x] Create `src/instrumentation.ts` for workers
- [x] Remove Express-specific files
- [x] Update `package.json` dependencies and scripts
- [x] Modify `src/config/env.ts` (lazy validated getter; no eager process exit)
- [ ] Test: `npm run dev` boots without errors
- [ ] Test: POST `/api/brain/ask` returns answers
- [ ] Test: Codebase import UI works with browse
- [ ] Test: Telegram bot responds

---

## 9. Validation results (performed)

- `npm install` completed and synchronized dependencies with Next.js runtime.
- `npm run build` passed successfully on Next.js `15.5.14`.
- App routes generated:
  - Pages: `/`, `/brain`, `/import/codebase`
  - API: `/api/health`, `/api/brain/ask`, `/api/import/telegram`, `/api/import/codebase`, `/api/import/status/[jobId]`, `/api/import/browse`, `/api/telegram/webhook`
- TypeScript/lint check during build passed.
- `src/config/env.ts` now validates lazily (first access), avoiding build-time hard exits while preserving strict runtime validation.

### Known warning

- Next.js reported multiple lockfiles and inferred workspace root from `c:\Users\adars\package-lock.json`.
- Optional cleanup:
  - Remove unintended parent lockfiles, or
  - Set `outputFileTracingRoot` in `next.config.ts` for explicit root behavior.
