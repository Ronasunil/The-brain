# PRD: Hybrid Synthesizer for @brain

**Date:** 2026-04-24
**Status:** Proposed
**Branch:** `main`
**Author:** Ronasunil (tech@tghtech.com)
**Effort:** ~6 CC-hours (roughly 3 human-days)

---

## 1. One-line summary

Route every `@brain` question through one unified pipeline that runs SQL **and** semantic retrieval in parallel, then lets an LLM synthesizer write one grounded answer. No more "is this a query or a search?" binary routing.

---

## 2. Problem

### 2.1 What users experience today

Users ask natural-language questions in chat. The quality of the answer depends entirely on whether the classifier guesses right about which path to take.

Concrete failure we have shipped to prod:

- **"any tickets completed by rona today"** → classifier dropped `statuses:["closed"]` and `completed_after`, ran as `{assignee_names:["rona"]}`, returned zero, said *"No open tickets assigned to rona."* Actual answer existed. User blamed the system.
- **"Backlog tickets rona created this week"** → classifier mapped `backlog` to the generic `open` category instead of `status_names:["Backlog"]`, returned three tickets including one "In Progress". Wrong.
- **"anything happening with auth lately?"** → no strong anchors, classifier forced into aggregation, returned a generic list of recent open tickets. Missed the 3 related chat messages where rohan flagged OAuth breakage.

Every one of these is a routing failure. The data exists. The system just looked in the wrong place.

### 2.2 Why the current architecture can't fix this

`src/services/query.service.ts:69-283` runs a rich **hybrid** semantic pipeline: 8 parallel retrievals (messages vector+FTS, entities vector+FTS, entity comments vector, code chunks vector+FTS, manual facts), Cohere rerank, then `AIService.generateAnswer` writes the answer.

`src/services/aggregation.service.ts:106-165` runs SQL only, uses deterministic formatters or LLM-authored response templates — never hits the semantic path, never calls `AIService.generateAnswer`.

The two paths are mutually exclusive. The classifier picks one. Wrong pick = wrong answer.

### 2.3 Why this is worth fixing now

The product promise the user stated, verbatim: *"whatever question I ask, if it's there in Linear, I need to get a proper answer."* Every routing mismatch violates that promise. And the infrastructure to fix it already exists — we just haven't plumbed it through.

---

## 3. CEO review — premise challenge + alternatives

### 3.1 Premises (stated, so they can be challenged)

| # | Premise | Risk if wrong |
|---|---------|--------------|
| P1 | Users want "ask anything, get right answer" (one surface) | User may actually want fast+cheap for count questions, rich for vague — in which case a two-mode UX beats one unified pipeline |
| P2 | SQL path failures are routing failures, not classifier failures | If classifier gets perfect, a better classifier + current routing could beat hybrid at lower cost |
| P3 | Semantic context enriches structured answers without lying | Hallucination risk — synthesizer could "read meaning into" SQL rows it shouldn't |
| P4 | Latency +500ms on some questions is acceptable in chat | If users pull answers constantly (>10/min), this compounds |
| P5 | Cost +$0.0003 per query is negligible | At 10k queries/day, that's ~$1/day — truly negligible |

**All five premises accepted.** P3 is the real risk; mitigated by the synthesizer prompt rule *"reference only provided items, never invent ticket IDs or titles."*

### 3.2 Alternatives considered

| Approach | Completeness | Effort | Verdict |
|---|---|---|---|
| **A: Smarter classifier (anchor-based rules)** | 6/10 — still binary, edge cases regress | 2h | Rejected. Every new pattern = new prompt rule. Drift. |
| **B: Zero-result RAG fallback** | 7/10 — catches zero cases but misses "wrong but >0 result" cases | 3h | Rejected. Bandaid. |
| **C: A + B combined** | 7/10 — still binary at the root | 4h | Rejected. Ships fast, regresses within two weeks. |
| **D: Hybrid synthesizer (this PRD)** | 9/10 — uses all 5 data surfaces, LLM synthesizes grounded answer | ~6h | **Chosen.** Matches spec. |
| **E: Full agent loop (plan→tool→reflect)** | 10/10 — could eventually beat D | ~3 days + eval harness | Deferred. Too much for v1. Revisit once v1 metrics exist. |

### 3.3 Scope decision — SELECTIVE EXPANSION

**In scope (blast radius):**
- `src/services/aggregation.service.ts` — stop being terminal; feed results to synthesizer
- `src/services/query.service.ts` — single orchestrator for all `@brain` questions
- `src/services/ai.service.ts` `generateAnswer` — extend to accept structured rows + aggregation context
- `src/socket.ts` — still routes `@brain` to `QueryService.ask`; path unchanged externally

**Deferred to TODOS.md:**
- Parallel multi-source re-ranker tuning (after we have quality metrics from v1)
- Streaming tokens to client (nice-to-have; current UX is fine at 2s)
- Per-workspace synthesizer prompt customization (enterprise feature, premature)
- Agent-loop / tool-use pattern (Approach E, next quarter)

### 3.4 Dream state delta

```
TODAY ──────────────────→ THIS PLAN ──────────────────→ 12-MONTH IDEAL
  │                         │                              │
  Two binary paths.         One unified pipeline.          Full agent loop with
  Wrong routing ships       LLM synthesizes across         tool-use, streaming,
  wrong answers.            SQL + semantic. Answers        cross-workspace
                            match user intent.             knowledge, autonomous
                                                           ticket triage.
```

This plan moves us ~60% toward the ideal. Approach E closes the remaining 40% but is a separate quarter of work.

---

## 4. Goals & non-goals

### 4.1 Goals

- Every `@brain` question goes through one pipeline (no visible behavior change in the chat UI).
- Structured questions ("how many urgent tickets") stay fast (<1s) and deterministic.
- Mixed questions ("tickets rona completed today") enrich SQL rows with related chat/comment context via the synthesizer.
- Vague questions ("anything about auth") get proper semantic answers grounded in real tickets + messages.
- Zero hallucination — synthesizer cites only provided items.
- Graceful degradation: if synthesizer fails, fall back to deterministic formatter. Nothing ever 500s.

### 4.2 Non-goals

- New data sources (we use what's already indexed).
- Streaming tokens to client (batch response is fine for now).
- Frontend changes (payload shape unchanged).
- Changes to `@ticket` flow, auth, or integrations.
- Schema migrations.

### 4.3 Success metrics

| Metric | Baseline (today) | Target (after v1) | Measurement |
|---|---|---|---|
| Zero-result rate on Linear questions | ~18% (estimated from `🧭 classify:` logs) | <5% | log `brain:empty:*` with original question |
| Wrong-routing complaints | Happening weekly | 0 per week | anecdotal + user feedback in chat |
| `@brain` median latency | ~1.0s | <2.0s | existing `chat:brain-thinking` timing |
| `@brain` p99 latency | ~1.8s | <3.0s | same |
| Synthesizer hallucinations (invented ticket IDs) | N/A | 0 in 100 sampled answers | manual audit once/week |
| Cost per question | ~$0.0005 | <$0.0015 | sum of Gemini + OpenAI + Cohere calls |

---

## 5. Target user flows

### 5.1 Flow A — structured count (fast path, unchanged)

```
User: "@brain how many urgent tickets?"
  ↓
Intent extractor returns:
  { intent: "aggregation", operation: "count",
    filters: { statuses: ["open"], priorities: [1] },
    retrieval_hint: "sql_only" }
  ↓
SQL count → 7
  ↓
Deterministic format: "There are 7 open urgent tickets."
  ↓
User sees answer in ~700ms
```

No synthesizer call. No semantic retrieval. Same cost and latency as today.

### 5.2 Flow B — structured + context (hybrid synthesis)

```
User: "@brain any tickets rona completed today?"
  ↓
Intent extractor returns:
  { intent: "aggregation", operation: "list",
    filters: { assignee_names: ["rona"], statuses: ["closed"],
               completed_after: "2026-04-24T00:00:00Z",
               completed_before: "2026-04-24T23:59:59Z" },
    retrieval_hint: "sql_dominant + context" }
  ↓
PARALLEL (reuse embedding from classifier call):
  • SQL list → 3 tickets (BRA-7, BRA-12, BRA-15)
  • messages.searchSimilar("rona completed today") → 1 chat msg
  ↓
Synthesizer prompt:
  Question: "any tickets rona completed today?"
  Structured results: 3 tickets [full metadata]
  Related chat: 1 message [content]
  Rules: cite only provided items; don't invent.
  ↓
Answer: "rona closed 3 tickets today: BRA-7 (auth), BRA-12 (payment retry),
         BRA-15 (DNS migration). In chat she mentioned BRA-12 might need a
         follow-up."
Sources: [BRA-7, BRA-12, BRA-15, chat:2026-04-24T14:32]
  ↓
User sees answer in ~1.8s
```

### 5.3 Flow C — vague exploratory (full hybrid)

```
User: "@brain anything about auth lately?"
  ↓
Intent extractor returns:
  { intent: "content",
    soft_filters: { updated_after: "2026-04-17T00:00:00Z" },
    retrieval_hint: "semantic_dominant" }
  ↓
PARALLEL:
  • Messages vector+FTS → 4 messages
  • Entities vector+FTS → 5 tickets
  • Entity comments vector → 2 comments
  • Code chunks vector+FTS → 1 file snippet (auth.ts)
  ↓
Rerank (Cohere) → top 10
  ↓
Synthesizer writes grounded summary + cites sources
  ↓
User sees answer in ~2.2s
```

This is basically today's semantic path, just triggered cleanly via the new unified entry point.

### 5.4 Flow D — zero results (honest message)

```
User: "@brain completed by sameer today" (sameer has 0 completed today)
  ↓
Intent extractor returns filters + response_templates
  ↓
SQL list → 0 tickets
Semantic retrieval runs in parallel, finds 2 older messages mentioning sameer
  ↓
Synthesizer sees: 0 SQL rows, 2 weakly-related messages
  ↓
Answer: "sameer hasn't completed any tickets today. Recent activity
         mentions him in two messages from earlier this week."
  ↓
User gets an honest, specific empty-state reply
```

Compare to today's *"No open tickets assigned to sameer"* — different person, different question, random misleading default.

---

## 6. Architecture

### 6.1 Before (current)

```
                    ┌──────────────────┐
                    │ socket.ts        │
                    │ @brain handler   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ QueryService.ask │
                    └────────┬─────────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
                  ▼                     ▼
      ┌────────────────────┐  ┌───────────────────────┐
      │ AggregationService │  │ 8-source hybrid +     │
      │   + templates      │  │ rerank + synthesizer  │
      │   (no LLM synth)   │  │ (AIService.generate)  │
      └────────────────────┘  └───────────────────────┘
           ↑ if aggregation         ↑ if content
```

Two terminal paths. Classifier chooses. Mistakes land as wrong answers.

### 6.2 After (hybrid synthesizer)

```
                    ┌──────────────────┐
                    │ socket.ts        │
                    │ @brain handler   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────────┐
                    │ BrainService.ask     │
                    │ (new orchestrator)   │
                    └────────┬─────────────┘
                             │
                             ▼
            ┌────────────────────────────┐
            │ Intent extractor           │
            │ (existing                  │
            │ AggregationService.classify│
            │ — now returns              │
            │ retrieval_hint too)        │
            └────────────────┬───────────┘
                             │
              ┌──────────────┼──────────────────────────┐
              │ (branch on retrieval_hint)              │
              ▼                                          ▼
    ┌───────────────────┐              ┌─────────────────────────────┐
    │ FAST PATH         │              │ HYBRID PATH                 │
    │ (sql_only)        │              │                             │
    │ SQL only          │              │ PARALLEL:                   │
    │ deterministic fmt │              │   - SQL (if filters)        │
    │                   │              │   - messages vec+FTS        │
    │                   │              │   - entities vec+FTS        │
    │                   │              │   - comments vec            │
    │                   │              │   - code vec+FTS            │
    │                   │              │                             │
    │                   │              │ Merge + rerank              │
    │                   │              │                             │
    │                   │              │ AIService.generateAnswer    │
    │                   │              │ (extended — accepts SQL     │
    │                   │              │ rows + semantic hits)       │
    └────────┬──────────┘              └──────────┬──────────────────┘
             │                                     │
             └────────────────┬────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │ BrainAnswer      │
                    │ { answer,        │
                    │   sources }      │
                    └──────────────────┘
```

One orchestrator. Fast path for strict structural questions. Hybrid path for everything else. Single exit shape. No new data stores.

### 6.3 Components

| Component | Status | File |
|---|---|---|
| Socket @brain handler | Keep as-is | `src/socket.ts:188-291` |
| `BrainService.ask` | **NEW** | `src/services/brain.service.ts` |
| Intent extractor (classifier) | Extend to emit `retrieval_hint` | `src/services/aggregation.service.ts` |
| SQL executor | Keep; called from BrainService | `src/services/aggregation.service.ts:106-165` |
| Messages retrieval | Keep | `src/db/message.repository.ts` |
| Entities vector retrieval | Keep | `src/db/entity.repository.ts` searchSimilar |
| Entities FTS retrieval | Keep | `src/db/entity.repository.ts` searchFullText |
| Comments retrieval | Keep | `src/db/entity.repository.ts` EntityCommentRepository |
| Code retrieval | Keep | `src/db/code-chunk.repository.ts` |
| Merger/rerank | Extract from query.service.ts | Move to `src/services/retrieval-merger.ts` (new) |
| `AIService.generateAnswer` | Extend signature to accept `aggregation` context | `src/services/ai.service.ts:20-113` |
| Response templates path | Keep as fallback | `src/services/aggregation.service.ts` (applyTemplate) |

Nothing in this list is new infrastructure. Everything except `BrainService` and the extraction of a merger helper already exists.

### 6.4 Data flow for the hybrid path

```
BrainService.ask(question, workspaceId)
  │
  ├─► AggregationService.classify(question)
  │     returns intent + retrieval_hint + response_templates
  │
  ├─► AIService.createEmbedding(question)  [parallel with classify]
  │
  ├─► Based on retrieval_hint.mode:
  │     'sql_only'        → run SQL only, format, return
  │     'sql_dominant'    → run SQL + messages semantic in parallel
  │     'semantic_dominant' → run all 5 retrieval sources
  │
  ├─► Collect results
  │
  ├─► retrieval-merger.merge(sources, hint weights)
  │     - dedupe by entity_id / message_id
  │     - score blend
  │     - top N (N=10)
  │
  ├─► AIService.generateAnswer(
  │     question,
  │     retrievedContext = { messages, code, aggregation: { rows, count } },
  │     response_templates (fallback if LLM fails)
  │   )
  │
  └─► return { answer, sources }
```

### 6.5 The `retrieval_hint` — new advisory field

Added to the classifier's output (existing schema extension). Replaces the rigid `intent: "aggregation" | "content"` binary with a soft recommendation:

```ts
retrieval_hint: {
  mode: "sql_only" | "sql_dominant" | "balanced" | "semantic_dominant",
  weights: {
    sql: 0.0 | 1.0,
    messages_vec: 0.0 – 1.0,
    entities_vec: 0.0 – 1.0,
    entities_fts: 0.0 – 1.0,
    comments: 0.0 – 1.0,
    code: 0.0 – 1.0,
  }
}
```

Examples:
- Pure count: `mode: "sql_only"` → fast path, no semantic, no synthesizer.
- Assignee+date filter: `mode: "sql_dominant"` → SQL + messages (context).
- Vague: `mode: "semantic_dominant"` → full hybrid, SQL skipped.
- Mixed: `mode: "balanced"` → everything runs.

Rules in the prompt:
- Strong numeric + strong filters → `sql_only`.
- Strong filters + open-ended phrasing → `sql_dominant`.
- No structured anchors + content question → `semantic_dominant`.
- When in doubt → `balanced`.

The LLM gets it wrong sometimes. The merger handles that — if SQL returns 0 but semantic has hits, the synthesizer writes from semantic. If semantic returns nothing but SQL has hits, templates fire. No path is load-bearing alone.

---

## 7. API changes

**External:** none. `chat:send` Socket.IO event unchanged. `/api/brain/ask` REST route unchanged (internally delegates to `BrainService`).

**Internal:**

- `AggregationService.classify` returns `retrieval_hint` (optional, back-compat — absence means `"balanced"`).
- `AIService.generateAnswer` gets an optional `aggregationContext` parameter with rows, count, group_by buckets.
- `QueryService.ask` becomes a thin wrapper delegating to `BrainService.ask` for back-compat with existing callers.

---

## 8. Schema changes

**None.** No migrations. All indexes already exist:

| Index | Used by |
|---|---|
| `idx_entities_search_vector` (GIN) | entities FTS retrieval (already wired) |
| `idx_entities_embedding` (ivfflat) | entities vector (already wired) |
| `idx_entities_open_by_assignee` (btree partial) | SQL executor |
| `idx_entities_completed_at` (btree partial) | SQL executor, date windows |
| `idx_entities_assignee_name_lower` (btree partial) | SQL fuzzy assignee match |
| messages embedding + FTS indexes | messages retrieval |

---

## 9. Implementation plan

### Step 1 — extract merger/rerank helper (30 min)

Move the merge + rerank block from `src/services/query.service.ts:194-245` into `src/services/retrieval-merger.ts`. Same behavior, just reusable.

```ts
// src/services/retrieval-merger.ts
export interface RetrievalSources {
  messages?: SearchResult[];
  entities?: EntitySearchResult[];
  comments?: CommentSearchResult[];
  code?: CodeSearchResult[];
  aggregation?: { rows: Entity[]; buckets?: Bucket[]; count?: number };
}

export async function mergeAndRerank(
  question: string,
  sources: RetrievalSources,
  hint: RetrievalHint,
  maxResults: number,
): Promise<RankedResults> { /* ... */ }
```

### Step 2 — extend classifier output with `retrieval_hint` (45 min)

- `src/lib/types/aggregation.types.ts` — add `retrieval_hint?: RetrievalHint` on `AggregationIntentAggregation`, and also on `content` intent (so content questions can express which semantic sources to weight).
- `src/lib/validations/aggregation.schema.ts` — Zod + Gemini JSON schema.
- `src/services/aggregation.service.ts` — update prompt to emit `retrieval_hint`. Worked examples for each mode.

Keep back-compat: if LLM doesn't emit it, default to `"balanced"`.

### Step 3 — extend `AIService.generateAnswer` (45 min)

Current signature accepts `searchResults`, `groundTruthFacts?`, `codeResults?`. Add `aggregationContext?`:

```ts
interface AggregationContext {
  rows?: Entity[];
  buckets?: Array<{ bucket: string; count: number }>;
  count?: number;
  operation?: "count" | "count_by" | "list" | "oldest" | "newest";
  filters?: AggregationFilters;
}

async generateAnswer(
  question: string,
  searchResults: SearchResult[],
  options?: {
    groundTruthFacts?: SearchResult[];
    codeResults?: CodeSearchResult[];
    aggregationContext?: AggregationContext;
  },
): Promise<string>
```

Prompt extension: when `aggregationContext` is present, inject a *"Structured query result:"* block before the general context block. Rule stays: *"cite only provided items; never invent IDs, titles, or counts."*

### Step 4 — write `BrainService.ask` (2 hours)

New file `src/services/brain.service.ts`:

```ts
export const BrainService = {
  async ask(question: string, workspaceId: string, integrationId?: string): Promise<BrainAnswer> {
    // 0. Ticket-ID short-circuit (copied from QueryService.ask lines 80-90)
    // 1. Parallel: classify + embedding
    // 2. Branch on retrieval_hint.mode:
    //    - sql_only: execute aggregation + deterministic/template format, return
    //    - otherwise: parallel retrievals (skip zero-weight sources), merge, synthesize
    // 3. Fallback chain: synthesizer error → template → deterministic formatter
    // 4. Return { answer, sources }
  },
};
```

Reuse everything: `AggregationService.execute` for SQL path, `MessageRepository.searchSimilar`, `EntityRepository.searchSimilar` + `searchFullText`, `EntityCommentRepository.searchSimilar`, `CodeChunkRepository`, `mergeAndRerank`, `AIService.generateAnswer`.

### Step 5 — wire through the entry points (30 min)

- `src/socket.ts:271` — change `ChatService.askBrain` callsite (internally calls `QueryService.ask`) — no change needed at socket layer.
- `src/services/chat.service.ts` `askBrain` — change it to call `BrainService.ask` instead of `QueryService.ask`. One line.
- `src/controllers/brain.controller.ts:18` — change `QueryService.ask` call to `BrainService.ask`.
- `src/services/telegram.service.ts:139` — change `QueryService.ask` call to `BrainService.ask`.
- Keep `QueryService.ask` as a thin forwarder to `BrainService.ask` for any call sites I miss.

### Step 6 — add observability (30 min)

One new log line per request:

```
🧠 brain [hint=sql_dominant] sources=[sql:3, msg:1] synth=ok latency=1820ms
🧠 brain [hint=semantic_dominant] sources=[msg:4, ent:5, com:2] synth=ok latency=2140ms
🧠 brain [hint=sql_only] sources=[sql:7] synth=skip latency=680ms
🧠 brain [hint=balanced] sources=[sql:0, msg:0] synth=fallback_templates latency=1100ms
```

Parseable. Makes post-launch tuning easy.

### Step 7 — tests (1.5 hours)

See §11.

### Step 8 — deprecation bar on response templates (15 min)

`response_templates` on the classifier output stays as a fallback for when the synthesizer fails. Not removed. Not primary. Document this in the code comment on `AggregationResponseTemplates`.

---

## 10. Effort summary

| Step | Description | CC-effort | Human-eq |
|---|---|---|---|
| 1 | Extract merger helper | 30 min | 2h |
| 2 | Extend classifier output | 45 min | 3h |
| 3 | Extend generateAnswer signature | 45 min | 3h |
| 4 | BrainService.ask orchestrator | 2h | 1 day |
| 5 | Wire entry points | 30 min | 2h |
| 6 | Observability logs | 30 min | 1h |
| 7 | Tests | 1.5h | 1 day |
| 8 | Deprecation comment | 15 min | 15 min |
| **Total** | | **~6h CC** | **~3 human-days** |

Fits comfortably in a single focused session. No external infra. No migrations.

---

## 11. Test plan

### 11.1 Test diagram — every new codepath

| Codepath | Test type | File |
|---|---|---|
| `retrieval_hint` parsing (present, missing, malformed) | unit | `test/aggregation/classify.test.ts` |
| `mergeAndRerank` with only SQL | unit | `test/retrieval-merger.test.ts` |
| `mergeAndRerank` with SQL + messages | unit | same |
| `mergeAndRerank` with all 4 sources | unit | same |
| `mergeAndRerank` zero-weight source skipping | unit | same |
| `AIService.generateAnswer` with `aggregationContext` | unit (mock LLM) | `test/ai-service.test.ts` |
| `BrainService.ask` sql_only path | integration | `test/brain-service.test.ts` |
| `BrainService.ask` sql_dominant path | integration | same |
| `BrainService.ask` semantic_dominant path | integration | same |
| `BrainService.ask` synthesizer failure → template fallback | integration | same |
| `BrainService.ask` zero-results honest-empty message | integration | same |
| End-to-end: chat:send @brain → answer | e2e | `test/e2e/brain-hybrid.test.ts` |

### 11.2 Eval suite — ground-truth questions

Create `test/evals/brain-hybrid-eval.jsonl` with 20 questions spanning all three flows. Each entry:

```json
{
  "question": "tickets rona completed today",
  "expected_mode": "sql_dominant",
  "expected_rows_include": ["BRA-7", "BRA-12"],
  "must_not_say": ["no open tickets"],
  "must_say_pattern": "(rona|Rona) .*(completed|closed|finished)"
}
```

Run via: `bun test:evals test/evals/brain-hybrid-eval.jsonl`. Gate: 18/20 pass before merge.

### 11.3 Non-regression checklist

- [ ] Existing `@brain` questions that worked still work (sample 10 from past logs)
- [ ] `@ticket` flow unaffected
- [ ] `/api/brain/ask` REST endpoint response shape unchanged
- [ ] Telegram `@brain` handler unchanged externally
- [ ] `QueryService.ask` still callable (thin wrapper)

---

## 12. Failure modes & fallback matrix

| Failure | Impact | Fallback | Who notices |
|---|---|---|---|
| Classifier (Gemini) timeout / bad JSON | No retrieval hint | Use `"balanced"` default weights | Nobody (transparent) |
| Embedding (OpenAI) error | No semantic | Run SQL + FTS only; synthesizer uses what it has | User gets slightly thinner answer |
| SQL error | No structured rows | Synthesizer uses semantic only | User gets semantic-only answer |
| Cohere rerank error | No rerank | Fall back to similarity sort (existing behavior) | User may get slightly less relevant ordering |
| Synthesizer (LLM) error | No natural answer | Response template → deterministic formatter → "I couldn't answer that right now, try again" | User sees fallback message instead of synthesized prose |
| All retrieval returns 0 + synthesizer errors | Empty + fallback fails | *"I couldn't find anything matching that. Try rephrasing?"* | User sees honest empty message |

Never 500. Never reveal stack traces. Always an answer, even if degraded.

---

## 13. Security & prompt injection

The existing `AIService.generateAnswer` already has:
- Random fence markers for ground-truth facts (`<<<GT-XXX_BEGIN_FACTS>>>`)
- Sanitization (`sanitizeForPrompt`) strips control chars
- Explicit system prompt rule that user-stored facts are data, not instructions

Extension rules for `aggregationContext`:
- Rows already come from our own DB (not user-generated content in the attack sense — every field except `title`/`body` is a Linear API artifact).
- `title` and `body` pass through the same `sanitizeForPrompt`.
- Synthesizer prompt explicitly says: *"Reference only items from the provided lists. Never synthesize new ticket IDs, titles, counts, or timestamps."*

No new attack surface vs. today's semantic path, which already feeds arbitrary message content to the LLM.

---

## 14. Observability & rollout

### 14.1 Rollout plan

1. **Day 1 — ship behind env flag.** `BRAIN_PIPELINE=legacy|hybrid`. Default `legacy`. Deploy.
2. **Day 1 evening — flip staging workspace to `hybrid`.** Ping self with 10 sample questions. Check logs.
3. **Day 2 — flip to `hybrid` for 1 real workspace (own).** Dogfood for 24 hours.
4. **Day 3 — review logs. If no hallucinations, no crashes, median latency <2.5s → flip default to `hybrid`.**
5. **Day 4 — remove legacy branch from `QueryService.ask`.** Delete env flag.

Rollback: flip env flag back. Zero schema changes means instant rollback.

### 14.2 Logs to watch post-launch

```
grep "🧠 brain" app.log | awk '{print $3}' | sort | uniq -c
  # distribution of retrieval_hint modes

grep "synth=fallback" app.log
  # synthesizer failures — should be rare

grep "🧠 brain.*latency=" app.log | awk '{print $NF}' | sort -n
  # latency distribution
```

### 14.3 Manual audit cadence

- Week 1: review 20 random answers/day. Hand-check for hallucinations. Zero tolerance.
- Week 2+: 10 random answers/week. Same.

---

## 15. DX considerations

### 15.1 Developer journey — adding a new retrieval source in the future

Today (before hybrid): adding a source means editing 2 places in `QueryService.ask` AND implementing a parallel branch in `AggregationService.execute` (or not). Two paths = two places to wire.

After hybrid: one new source = one new entry in `RetrievalSources`, one new branch in `mergeAndRerank`, one new weight field in `retrieval_hint`. Single path, single place.

This is a real DX win for us (the maintainers).

### 15.2 Debugging a wrong answer

Log line tells you:
- Which `retrieval_hint` mode fired
- How many items each source returned
- Whether synthesizer ran or fell back

To repro locally: grep the `🧠 brain` log for the question's timestamp, copy the sources into a test fixture, run `BrainService.ask` in isolation with `NODE_ENV=test`.

### 15.3 Error messages

All errors surface as `AppError` per CLAUDE.md conventions. Synthesizer fallback messages are human-readable, not stack traces. Template fallback messages are human-authored per existing pattern.

### 15.4 Onboarding friction

A new contributor reading `BrainService.ask` top-to-bottom should understand the whole @brain flow in one file, <200 lines. Deliberate: we keep the orchestrator simple and push complexity into helpers (classifier, merger, synthesizer) that have dedicated files.

---

## 16. Open questions

1. **Should `retrieval_hint` weights be continuous floats or discrete modes?** I recommend discrete modes (`sql_only | sql_dominant | balanced | semantic_dominant`) for v1 — easier for the LLM, easier to debug. Revisit if we see modes that don't fit.
2. **Should the synthesizer always cite sources inline (`[BRA-7]`) or only in the sources array?** Existing path does inline citations. Keep that.
3. **Ticket-ID short-circuit (`BRA-7` direct lookup) — keep it in BrainService or move to classifier?** Keep in BrainService. It's a pre-classifier optimization; saves a Gemini call for the common "show me BRA-7" ask.
4. **What happens if `retrieval_hint.mode = "sql_only"` but the user asked something vague?** That's a classifier misfire. The fast path returns a thin answer. Zero-result template fires. User sees something honest. We'd see it in the logs and tune the classifier prompt. Acceptable v1 failure mode.

---

## 17. Acceptance criteria

- [ ] `src/services/brain.service.ts` created, <250 lines, covers all 3 flows.
- [ ] `AggregationService.classify` emits `retrieval_hint` on all aggregation outputs.
- [ ] `AIService.generateAnswer` accepts optional `aggregationContext` without breaking existing callers.
- [ ] `retrieval-merger.ts` extracted and reusable.
- [ ] Unit tests pass for all codepaths in §11.1.
- [ ] Eval suite ≥18/20 before merge.
- [ ] `chat:send @brain "how many urgent tickets"` → fast path, <1s, exact count.
- [ ] `chat:send @brain "rona completed today"` → hybrid, synthesized answer with chat context if any.
- [ ] `chat:send @brain "anything about auth"` → full hybrid, prose summary with sources.
- [ ] Synthesizer hallucination audit: 0 invented IDs in 20 sampled answers.
- [ ] Rollback tested: flip env flag, legacy path restored, no code changes needed.

---

## 18. CEO consensus table (self-review, single-voice)

Codex voice unavailable locally. Single-voice review only.

| Dimension | Verdict | Notes |
|---|---|---|
| Premises valid? | ✅ | P1–P5 stated, P3 is main risk, mitigated via prompt |
| Right problem to solve? | ✅ | Product spec is explicit: "ask anything, get right answer" |
| Scope calibration correct? | ✅ | SELECTIVE EXPANSION — uses existing infra, no new systems |
| Alternatives explored? | ✅ | 5 alternatives with effort/completeness scored |
| Competitive risk covered? | ⚠️ | Nobody is shipping agent-loop brains internally yet. Approach E is the defense. |
| 6-month trajectory sound? | ✅ | Plan moves us 60% to ideal, clears path to Approach E |

## 19. Eng consensus table (self-review, single-voice)

| Dimension | Verdict | Notes |
|---|---|---|
| Architecture sound? | ✅ | Single orchestrator, existing components, clean seams |
| Test coverage sufficient? | ✅ | Unit + integration + eval suite + manual audit |
| Performance risks addressed? | ✅ | Fast path preserved for pure count; +500ms on hybrid is in budget |
| Security threats covered? | ✅ | No new attack surface vs today's semantic path |
| Error paths handled? | ✅ | Full fallback matrix in §12, never 500s |
| Deployment risk manageable? | ✅ | Env flag + instant rollback, no schema changes |

## 20. DX consensus table (self-review, single-voice)

| Dimension | Verdict | Notes |
|---|---|---|
| Code adder journey <30 min for new source? | ✅ | One file, one branch, one weight — see §15.1 |
| Debug loop fast? | ✅ | Single log line per request with all relevant fields |
| Error messages actionable? | ✅ | AppError + human-authored fallback copy |
| Docs findable? | ✅ | This PRD + inline code comments |
| Rollout safe? | ✅ | Env flag, dogfood, gradual flip |
| Dev env friction-free? | ✅ | No new env vars for local dev; fallbacks cover missing Cohere/Vertex |

---

## 21. Cross-phase themes

**Theme: reuse existing infrastructure.** All three review lenses (CEO, Eng, DX) independently flagged that the most expensive part of this feature — retrieval + rerank + LLM synthesis — already exists in `QueryService.ask`. The value of this PRD is plumbing, not new systems. This reinforces "SELECTIVE EXPANSION" as the right mode.

**Theme: observability is load-bearing.** CEO cares about metrics. Eng cares about debug logs. DX cares about fast debug loops. One well-structured log line (§6.5 + §14.2) serves all three.

**Theme: fallbacks are the product.** Zero-hallucination promise depends on synthesizer → template → deterministic chain. Not a nice-to-have; core to the user experience being honest.

---

## 22. Not in scope (explicit)

- Streaming token output
- Agent-loop / tool-use pattern (deferred to next quarter)
- Multi-workspace synthesizer prompt customization
- New data sources (GitHub issues as first-class, Notion, etc.)
- Changes to `@ticket` flow
- Frontend chat UI changes
- Schema migrations
- Per-user response personalization
- Multi-turn context / memory across messages in the same chat

---

## 23. Deferred to TODOS.md

- Add observability dashboard for `🧠 brain` log-line metrics (Grafana panel).
- Eval harness extension — auto-run brain-hybrid-eval.jsonl in CI on every PR touching these files.
- Quality tuning: once baseline metrics exist, A/B test `retrieval_hint` discrete-mode vs continuous-weights.
- Agent-loop / tool-use (Approach E) once v1 metrics prove out.

---

## 24. Completion summary

| Area | Status | Notes |
|---|---|---|
| Problem clearly stated | ✅ | §2 with concrete failing questions |
| Premises challenged | ✅ | §3.1 |
| Alternatives compared | ✅ | §3.2, 5 approaches |
| Scope decision justified | ✅ | §3.3, SELECTIVE EXPANSION |
| Architecture diagrammed | ✅ | §6.1 before, §6.2 after, §6.4 data flow |
| Implementation plan file-by-file | ✅ | §9, 8 steps, ~6h CC |
| Test plan concrete | ✅ | §11, codepath + eval + non-regression |
| Failure modes enumerated | ✅ | §12, 6 failure paths + fallbacks |
| Observability defined | ✅ | §14 |
| Security reviewed | ✅ | §13 |
| DX reviewed | ✅ | §15, §20 |
| Not-in-scope listed | ✅ | §22 |
| Deferred items captured | ✅ | §23 |

**Verdict: ready to implement.** No critical gaps. One minor gap: Codex outside-voice wasn't available locally, so dual-voice consensus tables are single-voice only (annotated in §18–20).
