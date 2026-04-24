# Progress PRD: Create Linear Tickets via Chat Interface

**Date:** 2026-04-24
**Status:** Implemented (v1)
**Branch:** `av/feat/codebase-indexing-by-serena-mcp`
**Requested by:** User

---

## 1. Feature Overview

The Brain already ingests Linear tickets via webhook and answers questions
about them through `@brain`. Write-back was missing: when a team decided in
chat to file a bug, they had to leave the chat, open Linear, copy context
back and forth, and lose momentum.

This PRD adds **ticket creation from chat**: users trigger a draft via
`@ticket <summary>` (explicit) or `@brain create a ticket about …` (natural
language, routed by a Vertex-AI classifier). A bot then walks the user
through three questions — team, priority, assignee — and files a real Linear
issue through the existing OAuth integration.

This is the first time the chat acts as an *action surface* rather than a
read-only Q&A surface. The underlying patterns (interactive draft state,
intent classifier, explicit+natural triggers) are reusable for future
actions (create GitHub issue, post Slack update, etc.).

---

## 2. UX Decisions (confirmed)

| Decision | Choice |
|---|---|
| Trigger | Both — explicit `@ticket <summary>` and classifier-routed `@brain …` |
| Create flow | One-shot (no preview/confirm step) |
| Team / priority / assignee | Interactive — bot asks in chat with numbered options |
| Description context | Trigger message only (no thread context) |

---

## 3. Acceptance Criteria

### Trigger detection

- [x] `@ticket <body>` on a `chat:send` starts a draft (`/^@ticket(?=\s|$)/i`)
- [x] `@ticket` with no body is rejected with a usage hint
- [x] `@brain <body>` runs the ticket-intent Vertex classifier
- [x] On `create_ticket`, the classifier's extracted `title`/`description` seed the draft
- [x] Classifier failure (Vertex unavailable, malformed JSON, timeout, Zod reject) silently falls back to normal `@brain` Q&A

### Interactive flow

- [x] Start prompts for a team with numbered options from Linear
- [x] Team reply accepts index, team key (case-insensitive), or unique name prefix
- [x] Priority prompt accepts `0..4`, name (urgent/high/medium/low), or `skip`/`none`
- [x] Assignee prompt accepts index, name prefix, `me` (matched by user email), or `skip`/`none`/`unassigned`
- [x] `cancel` / `/cancel` at any stage aborts with a confirmation
- [x] One draft per `(workspaceId, userId)` — a second `@ticket` refuses with "already in progress"

### Ticket creation

- [x] `LinearProvider.createIssue` called with `{ teamId, title, description, priority, assigneeId }`
- [x] Success: bot replies with identifier, URL, team/priority/assignee summary
- [x] No manual entity ingestion — existing Linear webhook path (`handleIssueEvent`) reflects the new issue within seconds
- [x] Failure: draft cleared, bot posts the error message, user can retry

### Error handling

- [x] No Linear integration → 412, friendly message naming Settings → Integrations
- [x] Integration `status !== "active"` → 412, names the current status
- [x] OAuth refresh fails → falls through to existing token (handled by `LinearService.getAccessToken`); hard failure surfaces via Linear API error
- [x] Workspace with zero teams → "No teams in your Linear workspace" message, no draft created
- [x] Idle draft TTL 10 min; janitor sweeps on 60s interval and posts expiry notice if the draft passed `awaiting_team`

### Non-regression

- [x] Existing `@brain` Q&A path unchanged when classifier returns `other`
- [x] No new Socket.IO events — bot replies reuse `chat:message`
- [x] `chat:join`, `chat:history`, `chat:typing`, `chat:brain-thinking`, `chat:brain-error` untouched

### Out of scope (v2)

- Multi-node / clustered draft state (in-memory Map assumes a single Node.js process)
- Preview-then-confirm mode
- Editing or commenting on existing tickets from chat
- Thread-context in description ("make a ticket about this" — last N messages)
- Linking the new ticket back to originating chat messages via `entity_links`
- Slash-command alternatives (`/ticket`, `/issue`)

---

## 4. Architecture

### 4.1 Draft state — in-memory Map

`Map<"${workspaceId}:${userId}", TicketDraft>` inside
`TicketCreationService`. Each draft tracks its stage
(`awaiting_team → awaiting_priority → awaiting_assignee → creating`), the
options fetched from Linear, and partial selections.

A 60-second `setInterval` janitor evicts drafts idle for 10 minutes and
posts an expiry notice (only if the draft had passed `awaiting_team` — to
avoid noise on abandoned first-step drafts).

**Accepted limitation:** drafts are lost on process restart; the feature
requires a single-node server (current deployment topology). Redis is the
natural next step when we cluster.

### 4.2 Intent classification — Vertex AI JSON mode

`TicketIntentService` at `src/services/ticket-intent.service.ts` mirrors
`AggregationService`:

- Calls `callVertexJson<T>` against Gemini 2.5 Flash-Lite
- JSON schema enforced server-side; Zod rejects shape drift client-side
- Warm-up at boot via `TicketIntentService.warmUp()`
- Any failure → `{ intent: "other" }` (safe to call, never throws)

The classifier runs on every `@brain` message **before** the aggregation
classifier and Q&A generation. Zero added wall-clock latency when both
Vertex calls can race: in practice we currently call them sequentially
because the existing aggregation path is inside `QueryService.ask()`, not
the socket layer — a parallel wiring is a v2 refinement.

### 4.3 Linear provider extensions

Three additions to `src/providers/linear.provider.ts` (reuse existing
`graphql()` helper — error mapping + `AppError` semantics):

| Method | GraphQL |
|---|---|
| `listTeams(token)` | `teams(first: 50) { nodes { id key name } }` |
| `listWorkspaceUsers(token)` | `users(first: 100, filter: { active: { eq: true } }) { nodes { id name email } }` |
| `createIssue(token, input)` | `issueCreate(input: IssueCreateInput!) { success, issue { id identifier url title } }` |

`createIssue` throws `AppError(502)` if `success: false` or GraphQL errors.

### 4.4 Token reuse

The existing `getAccessToken` helper in `linear.service.ts` (decrypt + auto-
refresh within REFRESH_SKEW_MS) is now **exported** as
`LinearService.getAccessToken`. `TicketCreationService` reuses it, so token
refresh logic stays in one place.

### 4.5 Socket wiring — `chat:send` extension

After persisting + broadcasting the user's message, `chat:send` in
`src/socket.ts` routes to:

1. `cancel` / `/cancel` → `TicketCreationService.cancelDraft`
2. User has an in-flight draft → `TicketCreationService.handleResponse` (stage parser)
3. `@ticket <body>` → `TicketCreationService.startDraft`
4. `@brain <body>` → `TicketIntentService.classify`; if `create_ticket`, `startDraft`; else normal Q&A

All `AppError`s from the service are persisted as bot `chat:message` replies
(via `ChatMessageRepository.create`) — the error experience is
conversational, not an out-of-band socket error.

### 4.6 Caching

Per-integration 60-second caches on `listTeams` and `listWorkspaceUsers`
inside `TicketCreationService` — avoids flooding Linear if many users start
drafts in burst. `createIssue` is never cached.

### 4.7 Data model

**No schema changes.** All additions are in-process.

---

## 5. Files Changed

### New

| Path | Purpose |
|---|---|
| `src/services/ticket-creation.service.ts` | State machine, option caching, Linear createIssue orchestration |
| `src/services/ticket-intent.service.ts` | Vertex classifier + warm-up |
| `src/lib/validations/ticket-intent.schema.ts` | Zod + OpenAPI JSON schema for classifier output |
| `src/lib/types/ticket-draft.types.ts` | `TicketDraft`, `DraftStage`, `ParseResult` |
| `docs/prds/PRD-chat-linear-ticket-creation-2026-04-24.md` | This PRD |

### Modified

| Path | Change |
|---|---|
| `src/providers/linear.provider.ts` | Added `listTeams`, `listWorkspaceUsers`, `createIssue` + types |
| `src/services/linear.service.ts` | Exported `getAccessToken` for TicketCreationService reuse |
| `src/socket.ts` | Added `TICKET_TRIGGER`, `CANCEL_RE`, `extractTicketRequest`, `emitBotError`; extended `chat:send` with cancel/draft/@ticket/@brain-classify branches |
| `src/server.ts` | `TicketIntentService.warmUp()` + `TicketCreationService.startJanitor()` at boot; `stopJanitor()` on SIGINT/SIGTERM |

---

## 6. Verification

### Manual

1. Connect Linear via existing OAuth flow.
2. In chat, send `@ticket login fails on Safari`. Verify team prompt appears, pick a team by number, priority by name (`high`), type `me`. Verify ticket exists in Linear UI with expected fields.
3. Start a draft and `cancel`. Confirm no issue is created.
4. Start a draft and wait 10 min. Confirm expiry message; next `@ticket` works.
5. Disconnect Linear in settings, send `@ticket x`. Confirm "not connected" message.
6. Reconnect. Send `@brain we should file a bug for the flaky auth test`. Confirm classifier routes to ticket flow.
7. Send `@brain how many open tickets are in ENG?`. Confirm aggregation still wins (no draft started).

### Automated (follow-up)

- Unit tests for `TicketCreationService` stage transitions, parsers, TTL, AppError paths
- Unit tests for `TicketIntentService` with mocked `callVertexJson`
- Provider-level tests for `listTeams`/`listWorkspaceUsers`/`createIssue` happy + error paths
- Socket.IO integration test covering the full `@ticket → team → priority → assignee → success` flow

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Classifier false-positive starts unwanted ticket flow | User types `cancel`; we accept ~1% friction rather than adding a preview step |
| In-memory drafts lost on deploy | Documented limitation; revisit with Redis when we cluster |
| Linear rate limits on concurrent drafts | 60s per-integration cache on teams/users; `createIssue` is one mutation per completed draft |
| Large teams/users lists truncated | `first: 50` / `first: 100` caps; bump to cursor pagination if we hear complaints |
| Long or multiline `@ticket` titles | Title = first line truncated to 80 chars; full body goes to description |

---

## 8. Future work

- Preview-then-confirm mode (per-workspace toggle)
- Edit / comment existing tickets (`@ticket ENG-432 add comment: …`)
- Thread-context summarization ("last N messages" → description)
- Redis-backed draft state for multi-node
- Auto-link the created ticket back to its originating chat message via `entity_links`
- Parallelize ticket-intent and aggregation classifiers on `@brain`
