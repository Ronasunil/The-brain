# Progress PRD: OrgBrain V1 — AI-Powered Team Memory

**Date:** 2026-03-20
**Status:** In Progress
**Branch:** main

---

## 1. Feature Overview

OrgBrain is an AI-powered organizational memory system that captures team conversations from messaging platforms (starting with Telegram), stores them as vector embeddings, and answers questions with cited sources. The V1 is a Telegram bot + REST API backed by Supabase (PostgreSQL + pgvector) and OpenAI.

---

## 2. What Was Done

### Core Infrastructure

- [x] `src/config/env.ts` — Zod-validated environment config (Supabase, OpenAI, Telegram, Port)
- [x] `src/app.ts` — Express app setup (helmet, cors, morgan, JSON parsing, routes, error handler)
- [x] `src/server.ts` — Entry point: starts Express + Telegram bot + Embedding worker, graceful shutdown
- [x] `.env.example` — Template with all required environment variables
- [x] `tsconfig.json` — Strict TypeScript config
- [x] `package.json` — All dependencies installed (express, openai, @supabase/supabase-js, node-telegram-bot-api, zod, stream-json, etc.)

### Database Layer

- [x] `src/db/client.ts` — Supabase singleton client
- [x] `src/db/message.repository.ts` — Full repository: create, findById, findBySourceId, updateEmbedding, searchSimilar, count, createBatch, getUnembedded
- [x] `src/db/migrations/001_initial_schema.sql` — messages table with VECTOR(1536), IVFFlat index, `search_messages` RPC function, unique constraint on (source, source_message_id)

### Services

- [x] `src/services/ai.service.ts` — OpenAI wrapper: `createEmbedding()` (text-embedding-3-small) and `generateAnswer()` (gpt-4o-mini)
- [x] `src/services/message.service.ts` — Real-time message ingestion: store + embed synchronously
- [x] `src/services/query.service.ts` — Query pipeline: embed question → vector search → AI answer with cited sources
- [x] `src/services/telegram.service.ts` — Telegram bot: polling mode, listens to messages, stores them, answers questions triggered by @orgbrain / /ask / /brain / /search
- [x] `src/services/import.service.ts` — Streaming import of Telegram Desktop export JSON (handles 100K+ messages without memory issues)
- [x] `src/services/embedding.worker.ts` — Background setInterval worker: embeds messages with `embedding IS NULL` in batches of 50 every 5 seconds

### Routes / API

- [x] `src/routes/main.route.ts` — Central router mounting all sub-routers under `/api`
- [x] `src/routes/health.route.ts` — `GET /api/health` — health check
- [x] `src/routes/brain.route.ts` — `POST /api/brain/ask` — ask a question, get AI answer with sources
- [x] `src/routes/import.route.ts` — `POST /api/import/telegram` (start import, returns 202 + job ID), `GET /api/import/status/:jobId` (check progress)

### Error Handling

- [x] `src/error/app-error.ts` — AppError class (statusCode, isOperational)
- [x] `src/error/error.handler.ts` — Global error handler + 404 catch-all for invalid routes
- [x] `src/lib/errors/app-error.ts` — Original AppError (still present from initial build)
- [x] `src/lib/errors/error-handler.ts` — Original withErrorHandler HOF

### Middleware / Validation / Types

- [x] `src/lib/middleware/validate-body.ts` — Zod body validation middleware
- [x] `src/lib/validations/brain.schema.ts` — `askQuestionSchema` (question string + optional workspace_id)
- [x] `src/lib/validations/telegram.schema.ts` — Telegram update schema
- [x] `src/lib/validations/import.schema.ts` — TelegramExportMessage interface, ImportStatus interface
- [x] `src/lib/types/api.types.ts` — ApiResponse interface
- [x] `src/lib/types/message.types.ts` — StoredMessage, CreateMessageInput, SearchResult, BrainAnswer
- [x] `src/lib/constants/app.constants.ts` — AI models, prompts, thresholds, default workspace ID
- [x] `src/lib/constants/import.constants.ts` — IMPORT_BATCH_SIZE (50), EMBEDDING_WORKER_INTERVAL_MS (5000), MIN_MESSAGE_LENGTH (3)

---

## 3. What's Remaining

### Setup & Testing (Immediate)

- [ ] Create Supabase project and run `001_initial_schema.sql` migration
- [ ] Get OpenAI API key and add to `.env`
- [ ] Create Telegram bot via BotFather and add token to `.env`
- [ ] Fill `.env` with all values and run `npm run dev`
- [ ] Test Telegram bot: send messages, ask questions, verify answers with sources
- [ ] Test import endpoint with real Telegram Desktop export file

### Code Quality (Before Open Source)

- [ ] Add unit tests (services, repository, import parsing)
- [ ] Add integration tests (API endpoints)
- [ ] Add ESLint + Prettier config
- [ ] Add Dockerfile + docker-compose for one-command local setup
- [ ] Add GitHub Actions CI (lint, test, build)
- [ ] Add Swagger/OpenAPI spec for API documentation
- [ ] Add structured logging (pino or winston) to replace `console.log`
- [ ] Add rate limiting on API endpoints
- [ ] Add API authentication (API key or JWT)
- [ ] Clean up duplicate error handling (`src/error/` vs `src/lib/errors/`)

### Features (V2 Roadmap)

- [ ] Slack integration (alongside Telegram)
- [ ] Web dashboard — search UI, analytics, manage workspaces
- [ ] Multi-workspace support (currently single default workspace)
- [ ] Knowledge graph / topic clustering
- [ ] Scheduled digest / summary of conversations
- [ ] Webhook mode for Telegram (instead of polling) for production
- [ ] Message deduplication improvements
- [ ] Admin panel for managing imports and embeddings
- [ ] Infrastructure auto-discovery (DNS, domain, hosting info)

---

## 4. Architecture & Key Decisions

### Layered Architecture

```
Route → Controller/Handler → Service → Repository → Supabase (PostgreSQL + pgvector)
```

- **Routes** are thin — just wiring paths to handlers
- **Services** contain all business logic, throw `AppError` for error states
- **Repository** is the only layer that touches the database

### Why Supabase + pgvector (not Pinecone/Weaviate)

- Free tier, PostgreSQL-native, no separate vector DB to manage
- Messages and embeddings live in the same table — simpler queries
- `search_messages` is a PL/pgSQL function using cosine similarity via `<=>` operator

### Why Polling (not Webhooks) for Telegram

- V1 simplicity — no need for HTTPS, domain, or SSL cert
- Works on localhost during development
- Webhooks are a V2 optimization for production

### Why Background Embedding Worker (not inline)

- Bulk imports would be impossibly slow if every message called OpenAI synchronously
- Import stores messages fast (batch INSERT, no API calls)
- Worker fills in embeddings gradually in the background (50 per 5 seconds)
- API stays responsive during large imports

### Why stream-json (not JSON.parse)

- Telegram exports can be 100K+ messages (63K+ lines)
- `JSON.parse()` would load the entire file into memory
- stream-json parses one message at a time — constant memory usage

---

## 5. Known Issues & Blockers

- **Duplicate error modules**: `src/error/` (user-created) and `src/lib/errors/` (original build) both exist — should consolidate into one
- **Import job tracking is in-memory**: If server restarts, import status is lost. Fine for V1, needs DB persistence for production
- **No authentication**: API endpoints are completely open — anyone can query or import
- **No `.gitignore`**: Needs one to exclude `node_modules/`, `.env`, `dist/`, etc.
- **Uncommitted files**: 10 modified files + 10 untracked files not yet committed (import feature, error refactor, embedding worker)

---

## 6. Files Changed

| File                                    | Status      | Description                                   |
| --------------------------------------- | ----------- | --------------------------------------------- |
| `src/config/env.ts`                     | Modified    | Zod-validated env config                      |
| `src/app.ts`                            | Modified    | Express setup with mainRouter + error handler |
| `src/server.ts`                         | Modified    | Added EmbeddingWorker start/stop              |
| `src/db/message.repository.ts`          | Modified    | Added createBatch(), getUnembedded()          |
| `src/lib/types/message.types.ts`        | Modified    | Added CreateMessageInput fields               |
| `src/services/ai.service.ts`            | Modified    | Formatting changes                            |
| `src/services/telegram.service.ts`      | Modified    | Formatting changes                            |
| `package.json`                          | Modified    | Added stream-json dependency                  |
| `README.md`                             | Modified    | Updated project README                        |
| `src/services/import.service.ts`        | **Created** | Streaming Telegram export importer            |
| `src/services/embedding.worker.ts`      | **Created** | Background embedding worker                   |
| `src/routes/import.route.ts`            | **Created** | Import API endpoints                          |
| `src/routes/main.route.ts`              | **Created** | Central router                                |
| `src/lib/constants/import.constants.ts` | **Created** | Import/worker constants                       |
| `src/lib/validations/import.schema.ts`  | **Created** | Import types & interfaces                     |
| `src/error/app-error.ts`                | **Created** | Refactored AppError class                     |
| `src/error/custom-error.ts`             | **Created** | Custom error base class                       |
| `src/error/error.handler.ts`            | **Created** | Global error handler + 404 handler            |

---

## 7. How to Resume

1. **Read this PRD first** — it has the full picture
2. **Immediate next step**: Commit all uncommitted changes (import feature, embedding worker, error refactor)
3. **Setup**: Create Supabase project → run migration SQL → get API keys → fill `.env` → `npm run dev`
4. **Test**: Send messages to bot, try `/ask where is DNS managed?`, test import endpoint
5. **Key context**: The import service uses streaming + batch insert (no embeddings). The EmbeddingWorker runs in background filling in embeddings. Both must be running for the full system to work.
6. **Cleanup needed**: Consolidate `src/error/` and `src/lib/errors/` into one error module
