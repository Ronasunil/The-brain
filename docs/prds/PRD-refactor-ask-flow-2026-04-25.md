# PRD — Refactor the "Ask" Flow for Readability

**Date:** 2026-04-25
**Branch:** `testing` (current state, 5,128 LOC of services)
**Scope:** The `BrainService.ask` pipeline only. Other controllers are out of scope for this PRD.
**Hard constraint:** Behavior identical. Same response, same logs (different format OK), same performance.

---

## 1. The picture today

You hit `POST /api/v1/brain/ask` and roughly this happens:

```
HTTP request
  │
  ▼
authenticate ─► validateBody ─► requireWorkspaceAccess
  │
  ▼
BrainController.ask  (parses payload, calls service)
  │
  ▼
BrainService.ask  (723 LOC orchestrator + helpers in one file)
  │
  ├─► classifyQuestion(q)           ── ticket-ID regex
  │     │
  │     └─► HIT: EntityRepository.findByExternalIdInWorkspace ─► ticketLookupAnswer
  │     └─► MISS: continue
  │
  ├─► QueryPlanService.generate(q)  ── Gemini Pro, ~30s timeout, returns SQL plan or null
  │
  ├─► IF plan:                       ── SQL path (94 LOC: runPlanPath)
  │     ├─► executePlan(plan, workspaceId)
  │     ├─► fetchManualFacts(...)       ── 1 embedding + 1 RPC
  │     ├─► AIService.generateAnswer(...)   ── synthesizer LLM call
  │     └─► buildSqlSources(rows) ─► return BrainAnswer
  │
  └─► ELSE plan==null:               ── Semantic path (66 LOC: runSemanticPath)
        ├─► selectSources(route)
        ├─► AIService.createEmbedding(q)
        ├─► runSemanticRetrieval(...)      ── 8 parallel DB calls, 123 LOC
        │     ├─► messages_vec, messages_fts
        │     ├─► entities_vec, entities_fts
        │     ├─► entity_comments
        │     ├─► code_vec, code_fts
        │     └─► manual
        │     ├─► dedupeByMessageId, dedupeByChunkId
        │     └─► resolveEntitiesAndComments  ── parent lookup
        ├─► mergeAndRerank(...)            ── Cohere rerank or sort
        ├─► AIService.generateAnswer(...)   ── synthesizer LLM call
        └─► buildSources(...) ─► return BrainAnswer
```

Every ask costs **3-4 LLM calls + 1-9 DB queries**. That's fine for a brain. The question is whether someone reading the code can SEE that structure.

Right now they can't. Here's what they actually see when they open `brain.service.ts`:

```
brain.service.ts                                    723 LOC
├── BrainService.ask (60 LOC)                       — top-level orchestrator
├── fetchManualFacts (22 LOC)                       — helper
├── runPlanPath (94 LOC)                            — SQL pipeline
│     └── inline plan-validation console.log block (11 LOC of logging mid-flow)
├── buildAggregationContext (14 LOC)                — adapter
├── buildSqlSources (19 LOC)                        — formatter
├── rowToEntityLike (25 LOC)                        — formatter
├── runSemanticPath (66 LOC)                        — semantic pipeline
├── runSemanticRetrieval (123 LOC)                  — 8-source parallel block
├── dedupeByMessageId (13 LOC)                      — helper
├── dedupeByChunkId (13 LOC)                        — helper
├── resolveEntitiesAndComments (68 LOC)             — comment-parent resolver
├── buildSources (46 LOC)                           — formatter
├── ticketLookupAnswer (27 LOC)                     — formatter
├── logScope (11 LOC)                               — log util
└── logBrain (16 LOC)                               — log util
```

The ask flow IS a 6-step pipeline, but the code reads as 15 functions in one file, with the orchestrator buried among helpers, formatters, and loggers.

---

## 2. The five things that hurt readability most

### 2.1 Two near-identical paths, copy-pasted
`runPlanPath` and `runSemanticPath` both:
- Call `AIService.generateAnswer` wrapped in identical try/catch
- Use the identical fallback string `"I couldn't answer that right now..."`
- Call `logBrain` with the same shape
- Both end with a different formatter (`buildSqlSources` vs `buildSources`)

Two pipelines that diverge in only the *retrieval* step. Today the divergence is hidden in two ~100-line functions that share most of their structure visually.

### 2.2 The 8-source Promise.all is a 100-line block
`runSemanticRetrieval` lines 411-502 — eight `sources.has(...) ? Repo.method(...) : skip<...>()` ternaries, each 8-12 lines. Adding a 9th source (e.g., new integration) means editing the destructure, adding a slot, and adding a conditional. Nobody can read this and immediately see "this fans out across 8 retrieval sources."

### 2.3 The synthesizer call is duplicated
Lines 217-230 (SQL path) and lines 354-368 (semantic path) are the same block:
```ts
let answerText: string;
let synthStatus: "ok" | "error" = "ok";
try {
  answerText = await AIService.generateAnswer(...);
} catch (err) {
  synthStatus = "error";
  console.warn(`⚠️  synthesizer failed: ${err.message}`);
  answerText = "I couldn't answer that right now. Try rephrasing or check back in a moment.";
}
```

If you change the fallback message you have to remember to do it twice. (You won't.)

### 2.4 Logging interleaved with business logic
`runPlanPath` has 11 lines of plan-validation `console.log` right in the middle (lines 161-198). It's just observability noise, but it dominates the function visually so the actual SQL path is harder to read.

### 2.5 Three "what's in the result" types fighting each other
- `runSemanticRetrieval` returns `SemanticResults` (manualResults, messages, entities, code)
- `mergeAndRerank` takes `RetrievalSources` (manualResults, messages, entities, code) — same shape, different name
- `mergeAndRerank` returns `MergedResults` (manualResults, ranked: UnifiedResult[])
- Final formatter takes `(SearchResult[], CodeSearchResult[])` extracted from the merged result

Same data, three names, two repackagings. A new dev has to keep three type maps in their head to follow the data.

---

## 3. What the ask flow should look like

Open `brain.service.ts` and see this:

```ts
// brain.service.ts — orchestrator only. ~50 LOC.
export const BrainService = {
  async ask(question, workspaceId, integrationId): Promise<BrainAnswer> {
    const trace = newTrace({ question, workspaceId });

    // 1. Direct ticket lookup short-circuit (e.g. "BRA-7").
    const direct = await tryDirectTicketLookup(question, workspaceId);
    if (direct) return trace.done("ticket_id", direct);

    // 2. LLM decides: structured (SQL) or content (semantic)?
    const planning = await planQuery(question);
    trace.planned(planning);

    // 3a. SQL path.
    if (planning.plan) {
      const sql = await runSqlRetrieval(planning.plan, workspaceId);
      if (sql.ok) {
        const answer = await synthesizeFromSql(question, sql, workspaceId, integrationId);
        return trace.done("sql", answer);
      }
      trace.note("sql failed → fall through to semantic");
    }

    // 3b. Semantic path.
    const semantic = await runSemanticRetrieval({
      question, workspaceId, integrationId, route: planning.route,
    });
    const ranked = await rerank(question, semantic);
    const answer = await synthesizeFromSemantic(question, ranked);
    return trace.done("semantic", answer);
  },
};
```

That fits on one screen. A new dev gets the shape in 30 seconds. Each step is a one-line call into a dedicated module. Drill into any of them only when you need to.

---

## 4. Target file layout

```
src/services/ask/
  ├── index.ts                  ← exports BrainService (the orchestrator above)
  ├── trace.ts                  ← newTrace(), structured single-line log per ask
  ├── classify.ts               ← tryDirectTicketLookup() + ticketLookupAnswer formatter
  ├── plan.ts                   ← planQuery() — wraps QueryPlanService.generate
  ├── retrieve-sql.ts           ← runSqlRetrieval() + manual-facts fetch
  ├── retrieve-semantic.ts      ← runSemanticRetrieval() + source registry
  ├── source-registry.ts        ← Record<SourceName, fetcher> — see §5.3
  ├── rerank.ts                 ← rerank() — wraps mergeAndRerank
  ├── synthesize.ts             ← synthesizeFromSql, synthesizeFromSemantic, common safe-call
  └── format.ts                 ← buildSources, buildSqlSources, rowToEntityLike, etc.
```

Today's `brain.service.ts` becomes a 3-line re-export shim for backward compatibility, then deleted in a follow-up.

`query-router.ts`, `query-plan.service.ts`, `retrieval-merger.ts`, `retrieval-scope.ts`, `ai.service.ts` all stay where they are — they're already tight, single-purpose modules.

---

## 5. Concrete abstractions

### 5.1 The `Trace` object

Replaces `logBrain` + `logScope` + ad-hoc `console.log` calls. Collects events during the ask, emits one structured log line at the end.

```ts
// trace.ts
type Path = "ticket_id" | "sql" | "semantic";

export function newTrace(meta: { question: string; workspaceId: string }) {
  const t0 = Date.now();
  const events: Record<string, unknown> = { ...meta };

  return {
    planned: (p: { plan: unknown; route: unknown }) => Object.assign(events, { planned: p }),
    executed: (r: { rows: number; elapsedMs: number }) => Object.assign(events, { sql: r }),
    scoped: (route, sources) => Object.assign(events, { scope: { route, sources: [...sources] } }),
    synthesized: (status: "ok" | "error") => Object.assign(events, { synth: status }),
    note: (msg: string) => ((events.notes ??= []) as string[]).push(msg),

    done<T>(path: Path, answer: T): T {
      console.log(JSON.stringify({
        kind: "brain.ask",
        path,
        elapsedMs: Date.now() - t0,
        ...events,
      }));
      return answer;
    },
  };
}
```

Single log line per ask. JSON. Easy to grep. Easy to ship to a log aggregator later.

### 5.2 The `synthesize` module — kill the duplicated try/catch

```ts
// synthesize.ts
const FALLBACK = "I couldn't answer that right now. Try rephrasing or check back in a moment.";

async function safeSynth(opts: GenerateOpts): Promise<{ text: string; ok: boolean }> {
  try {
    return { text: await AIService.generateAnswer(...opts), ok: true };
  } catch (err) {
    console.warn(`⚠️ synth: ${err instanceof Error ? err.message : err}`);
    return { text: FALLBACK, ok: false };
  }
}

export async function synthesizeFromSql(question, sql, workspaceId, integrationId) {
  const manualFacts = await fetchManualFacts(question, workspaceId, integrationId);
  const aggregationCtx = buildAggregationContext(sql);
  const { text, ok } = await safeSynth({
    question,
    searchResults: [],
    groundTruthFacts: manualFacts,
    aggregationCtx,
  });
  return { answer: text, sources: buildSqlSources(sql.rows), synthOk: ok };
}

export async function synthesizeFromSemantic(question, merged) {
  const { text, ok } = await safeSynth({
    question,
    searchResults: extractMessages(merged),
    groundTruthFacts: merged.manualResults.length ? merged.manualResults : undefined,
    codeResults: extractCode(merged),
  });
  return { answer: text, sources: buildSources(merged.manualResults, merged.ranked), synthOk: ok };
}
```

One fallback message. Two callers. Same shape as before — orchestrator just does `await synthesizeFromSemantic(question, ranked)`.

### 5.3 The source registry — kill the 100-line Promise.all

```ts
// source-registry.ts
type FetchCtx = {
  question: string;
  embedding: number[];
  workspaceId: string;
  integrationId?: string;
  threshold: number;
  fetchCount: number;
};

type FetchedBucket =
  | { kind: "messages";  results: SearchResult[] }
  | { kind: "entities";  results: EntitySearchResult[] }
  | { kind: "comments";  results: CommentResult[] }
  | { kind: "code";      results: CodeSearchResult[] }
  | { kind: "manual";    results: SearchResult[] };

export const SOURCE_FETCHERS: Record<SourceName, (c: FetchCtx) => Promise<FetchedBucket>> = {
  manual: async (c) => ({
    kind: "manual",
    results: await MessageRepository.searchManual(c.workspaceId, c.embedding, MANUAL_RESERVED_SLOTS, c.threshold, c.integrationId),
  }),
  messages_vec: async (c) => ({
    kind: "messages",
    results: await MessageRepository.searchSimilar(c.embedding, c.workspaceId, c.fetchCount, c.threshold, c.integrationId),
  }),
  messages_fts: async (c) => ({
    kind: "messages",
    results: await MessageRepository.searchFullText(c.question, c.workspaceId, FULLTEXT_SEARCH_LIMIT, c.integrationId),
  }),
  entities_vec:    async (c) => ({ kind: "entities", results: await EntityRepository.searchSimilar(...) }),
  entities_fts:    async (c) => ({ kind: "entities", results: await EntityRepository.searchFullText(...) }),
  entity_comments: async (c) => ({ kind: "comments", results: await EntityCommentRepository.searchSimilar(...) }),
  code_vec:        async (c) => ({ kind: "code",     results: await CodeChunkRepository.searchSimilar(...) }),
  code_fts:        async (c) => ({ kind: "code",     results: await CodeChunkRepository.searchFullText(...) }),
};
```

Then `runSemanticRetrieval` becomes:

```ts
// retrieve-semantic.ts
export async function runSemanticRetrieval(opts): Promise<MergedRetrieval> {
  const sources = selectSources(opts.route);
  const ctx = await buildFetchCtx(opts);

  const buckets = await Promise.all(
    [...sources].map(name => SOURCE_FETCHERS[name](ctx))
  );

  const grouped = groupByKind(buckets);

  return {
    manualResults: grouped.manual.flat(),
    messages: dedupeByMessageId(grouped.messages.flat()),
    entities: await resolveEntitiesAndComments(grouped.entities.flat(), grouped.comments.flat()),
    code: dedupeByChunkId(grouped.code.flat()),
  };
}
```

Adding a 9th source: add one entry to `SOURCE_FETCHERS`. That's it. Zero changes to the orchestrator. The dispatch is a `[...sources].map(name => REG[name](ctx))` — anyone can read that.

### 5.4 SQL retrieval as its own module

```ts
// retrieve-sql.ts
type SqlResult =
  | { ok: true; rows: Row[]; buckets?: Bucket[]; elapsedMs: number }
  | { ok: false; reason: string };

export async function runSqlRetrieval(plan, workspaceId): Promise<SqlResult> {
  logPlan(plan, workspaceId); // moved out of orchestrator
  try {
    const result = await executePlan(plan, workspaceId);
    return { ok: true, rows: result.rows, buckets: result.buckets, elapsedMs: result.elapsedMs };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
```

The "fall through to semantic on SQL failure" decision is now a one-liner in the orchestrator (`if (sql.ok) {...} else trace.note("sql failed")`), not buried 100 lines deep.

### 5.5 Trim the type Tetris

Today: `SemanticResults` → `RetrievalSources` → `MergedResults` → `(SearchResult[], CodeSearchResult[])`.

After: `MergedRetrieval` → `MergedResults`. Two types instead of four. Names match what they hold.

---

## 6. Phased rollout (each phase ships independently, tests pass)

### Phase 1 — Trace + safeSynth
**Files added:** `src/services/ask/trace.ts`, `src/services/ask/synthesize.ts` (with safeSynth + the two formatters).
**Files changed:** `brain.service.ts` — replace the two duplicated try/catch blocks with `safeSynth(...)`. Replace `logBrain` + `logScope` calls with `trace.done(...)` / `trace.scoped(...)`.
**Risk:** Low. Behavior identical. Log format changes from emoji-string to JSON — flag for ops if they grep logs.
**Acceptance:** Curl 5 different questions before/after, response bodies byte-identical.

### Phase 2 — Source registry
**Files added:** `src/services/ask/source-registry.ts`.
**Files changed:** `brain.service.ts` — `runSemanticRetrieval` shrinks from 123 LOC to ~30. Same return shape.
**Risk:** Low. Exact same DB calls in exact same shape. Only the dispatch changes.
**Acceptance:** Same as Phase 1 + verify all 8 sources still fire on a "fire all" question (route=null).

### Phase 3 — Split into ask/ subdirectory
**Files added:** the full `src/services/ask/*` tree.
**Files changed:** `brain.service.ts` becomes a 3-line re-export shim of `ask/index.ts` for any external callers (probably just `socket.ts` and `chat.service.ts`).
**Risk:** Medium (volume of file movement). No logic changes — just moves.
**Acceptance:** `tsc --noEmit` clean. All call sites of `BrainService.ask` continue to work.

### Phase 4 — Tighten types
**Files changed:** drop `SemanticResults` and `RetrievalSources` from `retrieval-merger.ts`. Single `MergedRetrieval` shape.
**Risk:** Low.
**Acceptance:** `tsc --noEmit` clean.

### Phase 5 — Delete the shim
**Files changed:** delete `brain.service.ts`. Update all imports to `from "./ask"`.
**Risk:** Low (mechanical find-and-replace).
**Acceptance:** `tsc --noEmit` clean. No dead imports.

### Phase 6 — Tests (parallel, blocks nothing)
**Files added:** `test/ask.spec.ts` covering:
- Ticket-ID hit returns ticket lookup answer
- Ticket-ID miss falls through to plan
- Plan returned, executes successfully → SQL path with manual facts
- Plan returned, execution fails → falls through to semantic
- Plan null → semantic path with all sources (route=null)
- Plan null + route=linear → semantic path with narrowed sources
- Synthesizer throws → fallback message returned, `synth: "error"` in log

Each test mocks `AIService`, `QueryPlanService`, repos. <2s per test.

---

## 7. What does NOT change (non-goals)

- **The actual algorithms.** Tickets-ID short-circuit, plan-then-execute, 8-way fan-out, rerank-or-sort, fence-marker prompt — all the same.
- **The SystemPrompt** in `ai.service.ts`. Untouched.
- **`QueryPlanService.generate`.** Already a single-purpose module.
- **`mergeAndRerank`.** Already small and focused. Just renames its input type.
- **`selectSources`.** Already a 90-LOC pure function. Untouched.
- **Repository code.** Untouched.
- **Public API.** Same `POST /api/v1/brain/ask`, same request, same response.
- **Adding a job queue / observability stack.** Out of scope for this PRD.
- **Splitting `linear.service.ts` (794 LOC) and `ticket-creation.service.ts` (596 LOC).** Same problem, separate refactor — not bundled here.

---

## 8. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Refactor changes a response shape | Medium | Phase 6 tests catch this. Until they exist, manual curl diff per phase. |
| Log format change breaks ops dashboards/grep | Low | One-line announce in PR. Old emoji format gone, JSON is searchable too. |
| Source registry typing is awkward (heterogeneous return shapes) | Medium | Tagged unions (`{kind, results}`). One groupBy step. Caught by `tsc`. |
| Splitting reveals an implicit dependency I missed | Low | Phase 3 only moves code; if `tsc` complains, the dep is named explicitly. Better to know. |
| `brain.service.ts` has external importers I missed | Low | Phase 3 keeps shim. Phase 5 grep-and-replace. |

---

## 9. Effort

| Phase | Human team | CC + agent |
|---|---|---|
| 1. Trace + safeSynth | 4 hours | 30 min |
| 2. Source registry | 4 hours | 30 min |
| 3. Split into ask/ tree | 1 day | 1 hour |
| 4. Tighten types | 2 hours | 15 min |
| 5. Delete shim | 1 hour | 10 min |
| 6. Tests (parallel) | 1 day | 1 hour |
| **Total** | **~3 days** | **~3.5 hours** |

---

## 10. After this lands

`brain.service.ts` (the file you grep for when something's wrong with an answer) becomes a 50-line orchestrator that reads top-to-bottom like the pipeline diagram. New dev opens it, sees the 6 steps, knows where to look. SQL-path debugging? Open `retrieve-sql.ts`. Adding a new retrieval source? Open `source-registry.ts`. Changing the fallback message? Open `synthesize.ts`. One reason to open each file.

That's the whole game.

---

## Open questions

1. **Phase 1 only, or all of 1-5?** Phase 1 is a 1-hour win and you can stop there if that's enough.
2. **Log format breakage OK?** Today: `🧠 brain [path=sql] rows=12 ...`. After: `{"kind":"brain.ask","path":"sql","sql":{"rows":12},...}`. Better for tooling, different for human grep.
3. **Tests in scope of this PR or separate?** Recommend in-scope (Phase 6 in parallel) — without them every phase is a leap of faith.
