import { MessageRepository } from "../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { AIService, AggregationContext } from "./ai.service";
import { QueryPlanService } from "./query-plan.service";
import {
  executePlan,
  PlanExecutionResult,
} from "../db/query-plan.executor";
import { QueryPlan } from "../lib/types/query-plan.types";
import { classifyQuestion } from "./query-router";
import {
  mergeAndRerank,
  entityToSearchResult,
  UnifiedResult,
} from "./retrieval-merger";
import {
  BrainAnswer,
  BrainAnswerSource,
  SearchResult,
  CodeSearchResult,
  Entity,
} from "../lib/types";
import { EntitySearchResult } from "../lib/types/entity.types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
  RERANK_INITIAL_FETCH,
  FULLTEXT_SEARCH_LIMIT,
  MANUAL_RESERVED_SLOTS,
  CODE_SEARCH_RESULTS,
} from "../lib/constants/app.constants";

/**
 * Brain Service — unified orchestrator for every @brain question.
 *
 * Flow:
 *   1. Ticket-ID short-circuit. "BRA-7" → direct PK lookup.
 *   2. Parallel: SQL generation (Gemini Pro) + question embedding.
 *   3. If the generator emitted SQL → validate + execute → rows are the
 *      structural answer.
 *   4. In parallel with SQL, fire the 8-source semantic retrieval. This
 *      always runs so the synthesizer has narrative context.
 *   5. Merge + rerank semantic hits.
 *   6. Synthesize a grounded natural-language answer from SQL rows +
 *      semantic snippets. The LLM is told to trust SQL numbers as
 *      authoritative and never invent IDs/counts.
 *
 * There is ONE happy path. If Gemini isn't configured or the SQL path
 * fails, the synthesizer writes from semantic context alone. No mode
 * flags, no legacy fallbacks — just a single pipeline.
 */

export const BrainService = {
  async ask(
    question: string,
    workspaceId: string,
    integrationId?: string,
  ): Promise<BrainAnswer> {
    const t0 = Date.now();

    // 1. Ticket-ID short-circuit.
    const { klass, hints } = classifyQuestion(question);
    if (klass === "structural" && hints.ticketId) {
      const externalId = `${hints.ticketId.teamKey}-${hints.ticketId.number}`;
      const direct = await EntityRepository.findByExternalIdInWorkspace(
        workspaceId,
        externalId,
      );
      if (direct) {
        logBrain({
          path: "ticket_id",
          rowCount: 1,
          semanticHits: 0,
          synth: "skip",
          elapsedMs: Date.now() - t0,
        });
        return ticketLookupAnswer(direct);
      }
      // Fall through on miss (typo / unknown team key).
    }

    // 2. Ask the LLM: is this a structured query or a content question?
    //    The plan is either a Supabase query shape (structured) or null
    //    (content). We trust that decision — no parallel "always run
    //    both" balanced mode.
    const planGen = await QueryPlanService.generate(question);

    if (planGen.plan) {
      // ─── SQL path: run the plan, synthesize from its rows + manual facts.
      return runPlanPath(
        planGen.plan,
        question,
        workspaceId,
        integrationId,
        t0,
      );
    }

    // ─── Semantic path: embedding + hybrid retrieval + synthesizer.
    return runSemanticPath(question, workspaceId, integrationId, t0);
  },
};

// ─── SQL path ───────────────────────────────────

/**
 * Fetch the workspace's manually-remembered "ground truth" facts and
 * rank them against the question. These are user-curated context
 * (things like "rona is on leave this week") that must apply on BOTH
 * the SQL and semantic paths — dropping them on one path leads to
 * answers that ignore known context.
 *
 * Cheap: 3 reserved slots via a single RPC; costs an extra embedding.
 */
async function fetchManualFacts(
  question: string,
  workspaceId: string,
  integrationId: string | undefined,
): Promise<SearchResult[]> {
  try {
    const embedding = await AIService.createEmbedding(question);
    return MessageRepository.searchManual(
      workspaceId,
      embedding,
      MANUAL_RESERVED_SLOTS,
      MIN_SIMILARITY_THRESHOLD,
      integrationId,
    );
  } catch (err) {
    // Manual facts are best-effort — never block the answer on their
    // retrieval. Log and return empty.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  fetchManualFacts failed, continuing without: ${msg}`);
    return [];
  }
}

async function runPlanPath(
  plan: QueryPlan,
  question: string,
  workspaceId: string,
  integrationId: string | undefined,
  t0: number,
): Promise<BrainAnswer> {
  // Log what's actually going to run (server-side tenant scope injected
  // by executor, so you know workspace_id + type='linear_ticket' are
  // always enforced regardless of what the LLM wrote).
  console.log(
    `🛡️  plan-validated (workspace=${workspaceId}, table=${plan.table})`,
  );
  console.log(`   ↳ SELECT: ${plan.select}`);
  if (plan.filters.length > 0) {
    console.log(`   ↳ FILTERS: ${JSON.stringify(plan.filters)}`);
  }
  if (plan.order_by)
    console.log(`   ↳ ORDER BY: ${JSON.stringify(plan.order_by)}`);
  if (plan.limit) console.log(`   ↳ LIMIT: ${plan.limit}`);
  if (plan.group_by) console.log(`   ↳ GROUP BY: ${plan.group_by}`);

  // Plan execution can fail if: the LLM emitted a nonexistent column, the DB
  // times out, Supabase throttles, or a filter op is malformed. In all those
  // cases, graceful degradation is better than a generic error — fall
  // through to the semantic path so the user still gets an answer.
  let result: PlanExecutionResult;
  try {
    result = await executePlan(plan, workspaceId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `⚠️  plan execution failed, falling through to semantic: ${msg}`,
    );
    return runSemanticPath(question, workspaceId, integrationId, t0);
  }

  console.log(
    `🗄️  plan:executed ${result.summary} elapsed=${result.elapsedMs}ms`,
  );
  if (result.rows.length > 0 && result.rows.length <= 10) {
    console.log(`   ↳ ROWS: ${JSON.stringify(result.rows, null, 0)}`);
  }
  if (result.buckets && result.buckets.length > 0) {
    console.log(`   ↳ BUCKETS: ${JSON.stringify(result.buckets)}`);
  }

  const aggregationCtx = buildAggregationContext(result);

  // Manual-remembered facts always apply (they're user-stored context,
  // not retrieval noise). Cheap — 3 reserved slots, single RPC. Passing
  // them on both paths prevents silent-blindspot bugs like "answer
  // ignored the 'rona is on leave' fact the user stored last week".
  const manualFacts = await fetchManualFacts(
    question,
    workspaceId,
    integrationId,
  );

  // Synthesize using the SQL rows + manual facts. No broader semantic
  // retrieval on this path — the LLM routed to SQL; trust that.
  let answerText: string;
  let synthStatus: "ok" | "error" = "ok";
  try {
    answerText = await AIService.generateAnswer(
      question,
      /* searchResults */ [],
      manualFacts.length > 0 ? manualFacts : undefined,
      /* codeResults */ undefined,
      aggregationCtx,
    );
  } catch (err) {
    synthStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  synthesizer failed: ${msg}`);
    answerText =
      "I couldn't answer that right now. Try rephrasing or check back in a moment.";
  }

  const sources = buildSqlSources(result.rows);

  logBrain({
    path: "sql",
    rowCount: result.rows.length,
    bucketCount: result.buckets?.length,
    semanticHits: manualFacts.length,
    synth: synthStatus,
    elapsedMs: Date.now() - t0,
  });

  return { answer: answerText, sources };
}

/**
 * Rows from the plan → AggregationContext shape the synthesizer already
 * understands. Three cases:
 *   - group_by buckets present → count_by
 *   - rows present              → list (synthesizer counts rows itself)
 *   - empty                     → count=0 so the synthesizer says "none"
 */
function buildAggregationContext(
  result: PlanExecutionResult,
): AggregationContext {
  if (result.buckets && result.buckets.length > 0) {
    return { operation: "count_by", buckets: result.buckets };
  }
  if (result.rows.length > 0) {
    return {
      operation: "list",
      rows: result.rows.map(rowToEntityLike),
    };
  }
  return { operation: "count", count: 0 };
}

function buildSqlSources(
  rows: Record<string, unknown>[],
): BrainAnswerSource[] {
  return rows.slice(0, 20).map((row) => {
    const state = (row.state as Record<string, unknown>) ?? {};
    const assignee =
      (state.assignee_name as string | undefined) ?? "unassigned";
    const title = String(row.title ?? state.title ?? "");
    return {
      content: title,
      user_name: assignee,
      source: "linear" as const,
      timestamp: row.external_updated_at
        ? new Date(String(row.external_updated_at))
        : new Date(),
      similarity: 1.0,
    };
  });
}

function rowToEntityLike(row: Record<string, unknown>): Entity {
  const now = new Date();
  return {
    id: String(row.id ?? ""),
    workspace_id: String(row.workspace_id ?? ""),
    integration_id: String(row.integration_id ?? ""),
    type: "linear_ticket",
    external_id: String(row.external_id ?? "?"),
    external_url: String(row.external_url ?? ""),
    title: String(row.title ?? ""),
    body: String(row.body ?? ""),
    state: (row.state as Record<string, unknown>) ?? row,
    participants: [],
    content_hash: "",
    external_created_at: row.external_created_at
      ? new Date(String(row.external_created_at))
      : now,
    external_updated_at: row.external_updated_at
      ? new Date(String(row.external_updated_at))
      : now,
    embedding: null,
    created_at: now,
    updated_at: now,
  };
}

// ─── Semantic path ──────────────────────────────

async function runSemanticPath(
  question: string,
  workspaceId: string,
  integrationId: string | undefined,
  t0: number,
): Promise<BrainAnswer> {
  const queryEmbedding = await AIService.createEmbedding(question);
  const semantic = await runSemanticRetrieval(
    question,
    queryEmbedding,
    workspaceId,
    integrationId,
  );

  const merged = await mergeAndRerank(question, {
    manualResults: semantic.manualResults,
    messages: semantic.messages,
    entities: semantic.entities,
    code: semantic.code,
  });

  const searchResults: SearchResult[] = [
    ...merged.manualResults,
    ...merged.ranked
      .filter((u) => u.origin === "message" && u.messageResult)
      .map((u) => u.messageResult as SearchResult),
  ];
  const codeResults: CodeSearchResult[] = merged.ranked
    .filter((u) => u.origin === "code" && u.codeResult)
    .map((u) => u.codeResult as CodeSearchResult);

  let answerText: string;
  let synthStatus: "ok" | "error" = "ok";
  try {
    answerText = await AIService.generateAnswer(
      question,
      searchResults,
      merged.manualResults.length > 0 ? merged.manualResults : undefined,
      codeResults.length > 0 ? codeResults : undefined,
      /* aggregationCtx */ undefined,
    );
  } catch (err) {
    synthStatus = "error";
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  synthesizer failed: ${msg}`);
    answerText =
      "I couldn't answer that right now. Try rephrasing or check back in a moment.";
  }

  logBrain({
    path: "semantic",
    rowCount: 0,
    semanticHits: searchResults.length + codeResults.length,
    synth: synthStatus,
    elapsedMs: Date.now() - t0,
  });

  return {
    answer: answerText,
    sources: buildSources(merged.manualResults, merged.ranked),
  };
}

interface SemanticResults {
  manualResults: SearchResult[];
  messages: SearchResult[];
  entities: SearchResult[];
  code: CodeSearchResult[];
}

async function runSemanticRetrieval(
  question: string,
  queryEmbedding: number[],
  workspaceId: string,
  integrationId: string | undefined,
): Promise<SemanticResults> {
  const fetchCount = AIService.supportsRerank()
    ? RERANK_INITIAL_FETCH
    : MAX_SEARCH_RESULTS;

  const wordCount = question.trim().split(/\s+/).length;
  const similarityThreshold =
    wordCount <= 3
      ? Math.min(MIN_SIMILARITY_THRESHOLD, 0.15)
      : MIN_SIMILARITY_THRESHOLD;

  const [
    manualResults,
    messagesCosine,
    messagesFullText,
    entityCosine,
    entityFullText,
    commentResults,
    codeCosine,
    codeFullText,
  ] = await Promise.all([
    MessageRepository.searchManual(
      workspaceId,
      queryEmbedding,
      MANUAL_RESERVED_SLOTS,
      similarityThreshold,
      integrationId,
    ),
    MessageRepository.searchSimilar(
      queryEmbedding,
      workspaceId,
      fetchCount,
      similarityThreshold,
      integrationId,
    ),
    MessageRepository.searchFullText(
      question,
      workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      integrationId,
    ),
    EntityRepository.searchSimilar(
      queryEmbedding,
      workspaceId,
      fetchCount,
      similarityThreshold,
      integrationId,
    ),
    EntityRepository.searchFullText(
      question,
      workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      integrationId,
    ),
    EntityCommentRepository.searchSimilar(
      queryEmbedding,
      workspaceId,
      fetchCount,
      similarityThreshold,
    ),
    CodeChunkRepository.searchSimilar(
      queryEmbedding,
      workspaceId,
      fetchCount,
      similarityThreshold,
      integrationId,
    ),
    CodeChunkRepository.searchFullText(
      question,
      workspaceId,
      FULLTEXT_SEARCH_LIMIT,
      integrationId,
    ),
  ]);

  const messages = dedupeByMessageId(messagesCosine, messagesFullText);
  const entities = await resolveEntitiesAndComments(
    entityCosine,
    entityFullText,
    commentResults,
  );
  const code = dedupeByChunkId(codeCosine, codeFullText);

  return { manualResults, messages, entities, code };
}

function dedupeByMessageId(
  a: SearchResult[],
  b: SearchResult[],
): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of [...a, ...b]) {
    if (seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    out.push(r);
  }
  return out;
}

function dedupeByChunkId(
  a: CodeSearchResult[],
  b: CodeSearchResult[],
): CodeSearchResult[] {
  const seen = new Set<string>();
  const out: CodeSearchResult[] = [];
  for (const r of [...a, ...b]) {
    if (seen.has(r.chunk.id)) continue;
    seen.add(r.chunk.id);
    out.push(r);
  }
  return out;
}

/** Merge entity hits + resolve comment parents for "comment on BRA-7" context. */
async function resolveEntitiesAndComments(
  entityCosine: EntitySearchResult[],
  entityFullText: EntitySearchResult[],
  commentResults: Array<{
    comment: {
      id: string;
      entity_id: string;
      workspace_id: string;
      author_id: string;
      author_name: string;
      content: string;
      external_created_at: Date;
    };
    similarity: number;
  }>,
): Promise<SearchResult[]> {
  const seen = new Set<string>();
  const out: SearchResult[] = [];

  for (const r of [...entityCosine, ...entityFullText]) {
    if (seen.has(r.entity.id)) continue;
    seen.add(r.entity.id);
    out.push(entityToSearchResult(r));
  }

  if (commentResults.length === 0) return out;

  const parentIds = Array.from(
    new Set(commentResults.map((r) => r.comment.entity_id)),
  );
  const parents = await Promise.all(
    parentIds.map((id) => EntityRepository.findById(id)),
  );
  const parentById = new Map<string, { external_id: string; title: string }>();
  for (const p of parents) {
    if (p) parentById.set(p.id, { external_id: p.external_id, title: p.title });
  }

  for (const r of commentResults) {
    const key = `comment:${r.comment.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parent = parentById.get(r.comment.entity_id);
    const parentTag = parent
      ? `[comment on ${parent.external_id} — ${parent.title}]`
      : "[comment]";
    out.push({
      message: {
        id: key,
        workspace_id: r.comment.workspace_id,
        integration_id: r.comment.entity_id,
        source: "linear",
        source_message_id: r.comment.id,
        user_name: r.comment.author_name,
        user_id: r.comment.author_id,
        chat_id: r.comment.entity_id,
        chat_name: parent?.external_id ?? "linear_comment",
        content: `${parentTag} ${r.comment.content}`,
        timestamp: r.comment.external_created_at,
        embedding: null,
        created_at: r.comment.external_created_at,
      },
      similarity: r.similarity,
    });
  }

  return out;
}

// ─── Output builders ────────────────────────────

function buildSources(
  manualResults: SearchResult[],
  ranked: UnifiedResult[],
): BrainAnswerSource[] {
  const out: BrainAnswerSource[] = [];

  for (const r of manualResults) {
    const msg = r.message;
    out.push({
      content: msg.content,
      user_name: msg.user_name,
      source: msg.source,
      timestamp: msg.timestamp,
      similarity: Math.round(r.similarity * 100) / 100,
    });
  }

  for (const u of ranked) {
    if (u.origin === "code" && u.codeResult) {
      const chunk = u.codeResult.chunk;
      out.push({
        content: chunk.content,
        user_name: "github",
        source: "github" as const,
        timestamp: chunk.created_at,
        similarity: Math.round(u.similarity * 100) / 100,
        file_path: chunk.file_path,
        line_start: chunk.line_start ?? undefined,
        line_end: chunk.line_end ?? undefined,
      });
      continue;
    }
    if (u.messageResult) {
      const msg = u.messageResult.message;
      out.push({
        content: msg.content,
        user_name: msg.user_name,
        source: msg.source,
        timestamp: msg.timestamp,
        similarity: Math.round(u.similarity * 100) / 100,
      });
    }
  }

  return out;
}

function ticketLookupAnswer(e: Entity): BrainAnswer {
  const state = e.state as Record<string, any>;
  const statusLabel = state.status_name ?? state.status ?? "unknown";
  const assignee = state.assignee_name ?? "unassigned";
  const priorityLabel = state.priority_label ?? "";
  const priority = priorityLabel ? ` [${priorityLabel}]` : "";
  const completedAt = state.completed_at as string | null | undefined;
  const completion =
    completedAt &&
    (state.status === "completed" || state.status === "cancelled")
      ? ` — completed ${new Date(completedAt).toISOString().slice(0, 10)}`
      : "";

  const line = `• ${e.external_id} — ${e.title} (${statusLabel}, ${assignee})${priority}${completion}\n  ${e.external_url}`;
  return {
    answer: line,
    sources: [
      {
        content: e.title,
        user_name: assignee,
        source: "linear" as const,
        timestamp: e.external_updated_at,
        similarity: 1.0,
      },
    ],
  };
}

// ─── Observability ──────────────────────────────

function logBrain(entry: {
  path: "ticket_id" | "sql" | "semantic";
  rowCount: number;
  bucketCount?: number;
  semanticHits: number;
  synth: "ok" | "skip" | "error";
  elapsedMs: number;
}): void {
  const bucketPart =
    entry.bucketCount && entry.bucketCount > 0
      ? ` buckets=${entry.bucketCount}`
      : "";
  console.log(
    `🧠 brain [path=${entry.path}] rows=${entry.rowCount}${bucketPart} semantic=${entry.semanticHits} synth=${entry.synth} total=${entry.elapsedMs}ms`,
  );
}
