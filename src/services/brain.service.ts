import { MessageRepository } from "../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { AIService, AggregationContext } from "./ai.service";
import { AggregationService } from "./aggregation.service";
import { QueryService } from "./query.service";
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
  AggregationIntent,
  AggregationIntentAggregation,
  RetrievalMode,
} from "../lib/types/aggregation.types";
import { env } from "../config/env";
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
 * Replaces the old binary "aggregation OR content" router in
 * QueryService.ask. Every question goes through classify → optional
 * structured SQL → semantic retrieval (if hint says so) → merge → LLM
 * synthesizer with grounding over BOTH structured rows and semantic
 * snippets.
 *
 * Rollback: set BRAIN_PIPELINE=legacy to bypass this and fall through to
 * the original QueryService.ask. See PRD-hybrid-synthesizer-2026-04-24.md.
 */

type Timings = {
  classify?: number;
  embed?: number;
  sql?: number;
  retrieve?: number;
  rerank?: number;
  synth?: number;
};

function now(): number {
  return Date.now();
}

function resolveMode(_intent: AggregationIntent): RetrievalMode {
  // TESTING MODE — every question is forced through the full hybrid path
  // (SQL + all semantic sources + synthesizer) so we can validate behaviour
  // across the board. Flip back to the hint-driven logic below when we're
  // ready to tune per-question cost/latency.
  //
  // Restore by uncommenting:
  //   const hint = _intent.retrieval_hint?.mode;
  //   if (hint) return hint;
  //   return _intent.intent === "aggregation" ? "sql_dominant" : "semantic_dominant";
  return "balanced";
}

function shouldRunSql(intent: AggregationIntent, mode: RetrievalMode): boolean {
  if (intent.intent !== "aggregation") return false;
  return mode !== "semantic_dominant";
}

function shouldRunMessages(mode: RetrievalMode): boolean {
  return mode !== "sql_only";
}

function shouldRunEntitiesAndCode(mode: RetrievalMode): boolean {
  // sql_dominant: skip — SQL already covers tickets; messages add the
  // "what did the team say" color.
  return mode === "balanced" || mode === "semantic_dominant";
}

export const BrainService = {
  async ask(
    question: string,
    workspaceId: string,
    integrationId?: string,
  ): Promise<BrainAnswer> {
    // Rollback switch — kept so BRAIN_PIPELINE=legacy falls through to the
    // pre-refactor pipeline with zero code changes.
    if (env.BRAIN_PIPELINE === "legacy") {
      return QueryService.ask(question, workspaceId, integrationId);
    }

    const t0 = now();
    const timings: Timings = {};

    // 0. Ticket-ID short-circuit. "BRA-7" → direct PK lookup, skip
    //    classifier + embedding entirely.
    const { klass, hints } = classifyQuestion(question);
    if (klass === "structural" && hints.ticketId) {
      const externalId = `${hints.ticketId.teamKey}-${hints.ticketId.number}`;
      const direct = await EntityRepository.findByExternalIdInWorkspace(
        workspaceId,
        externalId,
      );
      if (direct) {
        logBrain({
          mode: "ticket_id",
          sources: { sql: 1 },
          synth: "skip",
          latency: now() - t0,
        });
        return ticketLookupAnswer(direct);
      }
      // Fall through to hybrid path on miss (typo / unknown team key).
    }

    // 1. Parallel: classify + embedding. Both are ~400ms independent I/O.
    const tClassifyStart = now();
    const [intent, queryEmbedding] = await Promise.all([
      AggregationService.classify(question),
      AIService.createEmbedding(question),
    ]);
    timings.classify = now() - tClassifyStart;
    timings.embed = timings.classify;

    const mode = resolveMode(intent);

    // Dynamic similarity threshold — short questions need relaxed threshold.
    const wordCount = question.trim().split(/\s+/).length;
    const similarityThreshold =
      wordCount <= 3
        ? Math.min(MIN_SIMILARITY_THRESHOLD, 0.15)
        : MIN_SIMILARITY_THRESHOLD;

    // 2. SQL gather (if aggregation intent and hint allows).
    const aggIntent =
      intent.intent === "aggregation"
        ? (intent as AggregationIntentAggregation)
        : null;

    let aggregationCtx: AggregationContext | undefined;
    let sqlRows: Entity[] | undefined;
    if (aggIntent && shouldRunSql(aggIntent, mode)) {
      const tSqlStart = now();
      try {
        const gathered = await AggregationService.gather(aggIntent, workspaceId);
        timings.sql = now() - tSqlStart;
        if (gathered) {
          aggregationCtx = gathered;
          sqlRows = gathered.rows;
        }
      } catch (err) {
        // Never fail the whole query because SQL misfired — fall through
        // to semantic-only and let the synthesizer work with what it has.
        console.warn(
          "BrainService: AggregationService.gather failed:",
          (err as Error)?.message ?? err,
        );
      }
    }

    // 3. Fast path — pure SQL with no semantic enrichment needed.
    if (aggIntent && mode === "sql_only") {
      // Use the existing formatted path (templates + deterministic formatter).
      // This keeps pure-count questions cheap and deterministic.
      const answer = await AggregationService.execute(aggIntent, workspaceId);
      logBrain({
        mode,
        sources: { sql: aggregationCtx?.count ?? (sqlRows?.length ?? 0) },
        synth: "skip",
        latency: now() - t0,
      });
      return answer;
    }

    // 4. Semantic retrieval — parallel across the sources the hint asked for.
    const tRetrieveStart = now();
    const fetchCount = AIService.supportsRerank()
      ? RERANK_INITIAL_FETCH
      : MAX_SEARCH_RESULTS;

    const messagesEnabled = shouldRunMessages(mode);
    const entitiesEnabled = shouldRunEntitiesAndCode(mode);

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
      messagesEnabled
        ? MessageRepository.searchManual(
            workspaceId,
            queryEmbedding,
            MANUAL_RESERVED_SLOTS,
            similarityThreshold,
            integrationId,
          )
        : Promise.resolve([] as SearchResult[]),
      messagesEnabled
        ? MessageRepository.searchSimilar(
            queryEmbedding,
            workspaceId,
            fetchCount,
            similarityThreshold,
            integrationId,
          )
        : Promise.resolve([] as SearchResult[]),
      messagesEnabled
        ? MessageRepository.searchFullText(
            question,
            workspaceId,
            FULLTEXT_SEARCH_LIMIT,
            integrationId,
          )
        : Promise.resolve([] as SearchResult[]),
      entitiesEnabled
        ? EntityRepository.searchSimilar(
            queryEmbedding,
            workspaceId,
            fetchCount,
            similarityThreshold,
            integrationId,
          )
        : Promise.resolve([] as EntitySearchResult[]),
      entitiesEnabled
        ? EntityRepository.searchFullText(
            question,
            workspaceId,
            FULLTEXT_SEARCH_LIMIT,
            integrationId,
          )
        : Promise.resolve([] as EntitySearchResult[]),
      entitiesEnabled
        ? EntityCommentRepository.searchSimilar(
            queryEmbedding,
            workspaceId,
            fetchCount,
            similarityThreshold,
          )
        : Promise.resolve(
            [] as Array<{
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
          ),
      entitiesEnabled
        ? CodeChunkRepository.searchSimilar(
            queryEmbedding,
            workspaceId,
            fetchCount,
            similarityThreshold,
            integrationId,
          )
        : Promise.resolve([] as CodeSearchResult[]),
      entitiesEnabled
        ? CodeChunkRepository.searchFullText(
            question,
            workspaceId,
            FULLTEXT_SEARCH_LIMIT,
            integrationId,
          )
        : Promise.resolve([] as CodeSearchResult[]),
    ]);
    timings.retrieve = now() - tRetrieveStart;

    // 5. Per-source merge (cosine + FTS within each source).
    const mergedMessages = mergeByMessageId(messagesCosine, messagesFullText);
    const entityResults = await resolveEntitiesAndComments(
      entityCosine,
      entityFullText,
      commentResults,
    );
    const mergedCode = mergeByChunkId(codeCosine, codeFullText);

    // 6. Cross-source rerank + dedupe against manual slots.
    const tRerankStart = now();
    const merged = await mergeAndRerank(question, {
      manualResults,
      messages: mergedMessages,
      entities: entityResults,
      code: mergedCode,
    });
    timings.rerank = now() - tRerankStart;

    // 7. Synthesize.
    const searchResults: SearchResult[] = [
      ...merged.manualResults,
      ...merged.ranked
        .filter((u) => u.origin === "message" && u.messageResult)
        .map((u) => u.messageResult as SearchResult),
    ];
    const codeResults: CodeSearchResult[] = merged.ranked
      .filter((u) => u.origin === "code" && u.codeResult)
      .map((u) => u.codeResult as CodeSearchResult);

    const tSynthStart = now();
    let synthStatus: "ok" | "fallback_templates" | "fallback_formatter" | "error" =
      "ok";
    let answerText: string;
    try {
      answerText = await AIService.generateAnswer(
        question,
        searchResults,
        merged.manualResults.length > 0 ? merged.manualResults : undefined,
        codeResults.length > 0 ? codeResults : undefined,
        aggregationCtx,
      );
    } catch (err) {
      console.warn(
        "BrainService: synthesizer failed, falling back:",
        (err as Error)?.message ?? err,
      );
      synthStatus = "error";
      // Fallback chain: if we have an aggregation intent, let templates/
      // deterministic formatter answer. Otherwise use a human fallback.
      if (aggIntent) {
        const formatted = await AggregationService.execute(
          aggIntent,
          workspaceId,
        );
        synthStatus = "fallback_templates";
        logBrain({
          mode,
          sources: sourceCounts(
            merged,
            aggregationCtx,
            searchResults,
            codeResults,
          ),
          synth: synthStatus,
          latency: now() - t0,
        });
        return formatted;
      }
      answerText =
        "I couldn't answer that right now. Try rephrasing or check back in a moment.";
    }
    timings.synth = now() - tSynthStart;

    // 8. Build sources list for the chat UI.
    const sources = buildSources(merged.manualResults, merged.ranked);

    logBrain({
      mode,
      sources: sourceCounts(merged, aggregationCtx, searchResults, codeResults),
      synth: synthStatus,
      latency: now() - t0,
      timings,
    });

    return { answer: answerText, sources };
  },
};

// ─── Helpers ─────────────────────────────────────

function mergeByMessageId(
  a: SearchResult[],
  b: SearchResult[],
): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of a) {
    if (seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    out.push(r);
  }
  for (const r of b) {
    if (seen.has(r.message.id)) continue;
    seen.add(r.message.id);
    out.push(r);
  }
  return out;
}

function mergeByChunkId(
  a: CodeSearchResult[],
  b: CodeSearchResult[],
): CodeSearchResult[] {
  const seen = new Set<string>();
  const out: CodeSearchResult[] = [];
  for (const r of a) {
    if (seen.has(r.chunk.id)) continue;
    seen.add(r.chunk.id);
    out.push(r);
  }
  for (const r of b) {
    if (seen.has(r.chunk.id)) continue;
    seen.add(r.chunk.id);
    out.push(r);
  }
  return out;
}

/**
 * Merge entity cosine + FTS hits, plus resolve comment parents so the LLM
 * sees "comment on BRA-7 — Setup google auth" instead of an orphan snippet.
 */
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

  for (const r of entityCosine) {
    if (seen.has(r.entity.id)) continue;
    seen.add(r.entity.id);
    out.push(entityToSearchResult(r));
  }
  for (const r of entityFullText) {
    if (seen.has(r.entity.id)) continue;
    seen.add(r.entity.id);
    out.push(entityToSearchResult(r));
  }

  if (commentResults.length === 0) return out;

  // Batch parent lookup — N comments on same entity → 1 lookup.
  const parentIds = Array.from(
    new Set(commentResults.map((r) => r.comment.entity_id)),
  );
  const parents = await Promise.all(
    parentIds.map((id) => EntityRepository.findById(id)),
  );
  const parentById = new Map<string, { external_id: string; title: string }>();
  parents.forEach((p) => {
    if (p)
      parentById.set(p.id, { external_id: p.external_id, title: p.title });
  });

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

interface SourceCounts {
  sql?: number;
  msg?: number;
  ent?: number;
  com?: number;
  code?: number;
}

function sourceCounts(
  merged: { manualResults: SearchResult[]; ranked: UnifiedResult[] },
  aggregationCtx: AggregationContext | undefined,
  searchResults: SearchResult[],
  codeResults: CodeSearchResult[],
): SourceCounts {
  const counts: SourceCounts = {};
  if (aggregationCtx) {
    counts.sql =
      aggregationCtx.rows?.length ??
      aggregationCtx.buckets?.length ??
      aggregationCtx.count ??
      0;
  }
  const msgCount = searchResults.length;
  if (msgCount > 0) counts.msg = msgCount;
  if (codeResults.length > 0) counts.code = codeResults.length;
  return counts;
}

function logBrain(entry: {
  mode: RetrievalMode | "ticket_id";
  sources: SourceCounts;
  synth: "ok" | "skip" | "fallback_templates" | "fallback_formatter" | "error";
  latency: number;
  timings?: Timings;
}): void {
  const src = Object.entries(entry.sources)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
  const timing = entry.timings
    ? ` timings=${Object.entries(entry.timings)
        .filter(([, v]) => typeof v === "number")
        .map(([k, v]) => `${k}:${v}ms`)
        .join(",")}`
    : "";
  console.log(
    `🧠 brain [hint=${entry.mode}] sources=[${src}] synth=${entry.synth} latency=${entry.latency}ms${timing}`,
  );
}
