import { MessageRepository } from "../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { AIService } from "./ai.service";
import { AggregationService } from "./aggregation.service";
import { classifyQuestion } from "./query-router";
import {
  BrainAnswer,
  BrainAnswerSource,
  SearchResult,
  CodeSearchResult,
} from "../lib/types";
import { EntitySearchResult, Entity } from "../lib/types/entity.types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
  RERANK_INITIAL_FETCH,
  RERANK_MODEL,
  RERANK_TOP_N,
  FULLTEXT_SEARCH_LIMIT,
  MANUAL_RESERVED_SLOTS,
  CODE_SEARCH_RESULTS,
} from "../lib/constants/app.constants";

interface UnifiedResult {
  id: string;
  content: string;
  similarity: number;
  origin: "message" | "code";
  messageResult?: SearchResult;
  codeResult?: CodeSearchResult;
}

function codeToUnified(result: CodeSearchResult): UnifiedResult {
  return {
    id: result.chunk.id,
    content: result.chunk.content,
    similarity: result.similarity,
    origin: "code",
    codeResult: result,
  };
}

function messageToUnified(result: SearchResult): UnifiedResult {
  return {
    id: result.message.id,
    content: result.message.content,
    similarity: result.similarity,
    origin: "message",
    messageResult: result,
  };
}

/**
 * Query Service — the brain's query pipeline.
 *
 * Flow:
 * 1. User asks a question
 * 2. Generate embedding of the question
 * 3. Hybrid search: cosine + full-text across BOTH messages and code_chunks
 * 4. Merge and deduplicate results
 * 5. Rerank with Cohere rerank (if available)
 * 6. Send relevant context to AI
 * 7. Return structured answer with sources
 */
export const QueryService = {
  async ask(
    question: string,
    workspaceId: string,
    integrationId?: string,
  ): Promise<BrainAnswer> {
    // Ticket-ID short-circuit: if the user typed "ENG-423" we do an O(1)
    // primary-key lookup and skip embeddings + rerank entirely. Every other
    // question goes through the hybrid retrieval path below, where the
    // enriched tsvector (migration 006) carries assignee / email / status /
    // labels so questions like "assigned to rona@tghtech" work via FTS.
    const { klass, hints } = classifyQuestion(question);
    if (klass === "structural" && hints.ticketId) {
      const externalId = `${hints.ticketId.teamKey}-${hints.ticketId.number}`;
      const direct = await EntityRepository.findByExternalIdInWorkspace(
        workspaceId,
        externalId,
      );
      if (direct) return ticketLookupAnswer(direct);
      // Fall through to semantic search if the exact ID didn't match —
      // could be a typo or a team key we don't recognize.
    }

    const useRerank = AIService.supportsRerank();

    // 1. In parallel: ask Gemini "is this an aggregation question?" AND
    //    generate the embedding for the semantic path. Whichever one wins,
    //    the other wasn't wasted — aggregation short-circuits and semantic
    //    continues with the embedding we already paid for.
    const [aggIntent, queryEmbedding] = await Promise.all([
      AggregationService.classify(question),
      AIService.createEmbedding(question),
    ]);

    if (aggIntent.intent === "aggregation") {
      try {
        return await AggregationService.execute(aggIntent, workspaceId);
      } catch (err: any) {
        // If the SQL aggregate failed, fall through to semantic rather than
        // 500-ing the user. Logged so we can investigate.
        console.warn(
          "AggregationService.execute failed, falling through to semantic:",
          err?.message ?? err,
        );
      }
    }

    // Dynamic similarity threshold: short questions don't carry enough signal
    // for the default 0.3 to be useful, so we relax it. Long questions stay
    // strict. Keeps false-positives down for rich queries while giving short
    // ones a fighting chance.
    const wordCount = question.trim().split(/\s+/).length;
    const similarityThreshold =
      wordCount <= 3
        ? Math.min(MIN_SIMILARITY_THRESHOLD, 0.15)
        : MIN_SIMILARITY_THRESHOLD;

    // 2. Pre-fetch manual facts + run searches across messages, entities,
    //    comments, and code chunks in parallel. All four are first-class
    //    sources that can surface in the final answer.
    const fetchCount = useRerank ? RERANK_INITIAL_FETCH : MAX_SEARCH_RESULTS;
    const [
      manualResults,
      cosineResults,
      fulltextResults,
      entityCosine,
      entityFullText,
      commentResults,
      codeCosineResults,
      codeFulltextResults,
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

    // 3. Merge per-source duplicates (cosine wins when a row appears in both).
    const mergedMessages = this.mergeResults(cosineResults, fulltextResults);
    const entityResults = await mergeEntitySources(
      entityCosine,
      entityFullText,
      commentResults,
    );
    const mergedCode = this.mergeCodeResults(
      codeCosineResults,
      codeFulltextResults,
    );

    // 4. Unify all sources into one ranking pool so the reranker — or the
    //    similarity sort fallback — sees them as apples-to-apples.
    const allUnified: UnifiedResult[] = [
      ...mergedMessages.map(messageToUnified),
      ...entityResults.map(messageToUnified),
      ...mergedCode.map(codeToUnified),
    ];

    let rankedUnified: UnifiedResult[];
    if (useRerank && allUnified.length > 0) {
      const documents = allUnified.map((r) => r.content);
      const reranked = await AIService.rerank(question, documents, {
        topN: Math.min(RERANK_TOP_N, allUnified.length),
        model: RERANK_MODEL,
      });

      rankedUnified = reranked.map((r) => ({
        ...allUnified[r.index],
        similarity: r.relevanceScore,
      }));
    } else {
      rankedUnified = allUnified
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SEARCH_RESULTS + CODE_SEARCH_RESULTS);
    }

    const manualIds = new Set(manualResults.map((r) => r.message.id));
    const dedupedRanked = rankedUnified.filter(
      (r) => !manualIds.has(r.id),
    );

    const totalSlots = MAX_SEARCH_RESULTS + CODE_SEARCH_RESULTS;
    const finalUnified: UnifiedResult[] = dedupedRanked.slice(
      0,
      totalSlots - manualResults.length,
    );

    const manualAsUnified: UnifiedResult[] = manualResults.map(messageToUnified);
    const allFinal = [...manualAsUnified, ...finalUnified];

    const finalSearchResults: SearchResult[] = allFinal
      .filter((u) => u.origin === "message" && u.messageResult)
      .map((u) => u.messageResult!);

    const answer = await AIService.generateAnswer(
      question,
      finalSearchResults,
      manualResults.length > 0 ? manualResults : undefined,
      allFinal
        .filter((u) => u.origin === "code" && u.codeResult)
        .map((u) => u.codeResult!),
    );

    const sources: BrainAnswerSource[] = allFinal.map((u) => {
      if (u.origin === "code" && u.codeResult) {
        const chunk = u.codeResult.chunk;
        return {
          content: chunk.content,
          user_name: "github",
          source: "github" as const,
          timestamp: chunk.created_at,
          similarity: Math.round(u.similarity * 100) / 100,
          file_path: chunk.file_path,
          line_start: chunk.line_start ?? undefined,
          line_end: chunk.line_end ?? undefined,
        };
      }
      const msg = u.messageResult!.message;
      return {
        content: msg.content,
        user_name: msg.user_name,
        source: msg.source,
        timestamp: msg.timestamp,
        similarity: Math.round(u.similarity * 100) / 100,
      };
    });

    return { answer, sources };
  },

  mergeResults(
    cosineResults: SearchResult[],
    fulltextResults: SearchResult[],
  ): SearchResult[] {
    const seen = new Set<string>();
    const merged: SearchResult[] = [];

    for (const result of cosineResults) {
      seen.add(result.message.id);
      merged.push(result);
    }

    for (const result of fulltextResults) {
      if (!seen.has(result.message.id)) {
        seen.add(result.message.id);
        merged.push(result);
      }
    }

    return merged;
  },

  mergeCodeResults(
    cosineResults: CodeSearchResult[],
    fulltextResults: CodeSearchResult[],
  ): CodeSearchResult[] {
    const seen = new Set<string>();
    const merged: CodeSearchResult[] = [];

    for (const result of cosineResults) {
      seen.add(result.chunk.id);
      merged.push(result);
    }

    for (const result of fulltextResults) {
      if (!seen.has(result.chunk.id)) {
        seen.add(result.chunk.id);
        merged.push(result);
      }
    }

    return merged;
  },
};

// ─── Direct ticket-ID lookup answer ─────────────

function ticketLookupAnswer(e: Entity): BrainAnswer {
  const state = e.state as Record<string, any>;
  const statusLabel = state.status_name ?? state.status ?? "unknown";
  const assignee = state.assignee_name ?? "unassigned";
  const priorityLabel = state.priority_label ?? "";
  const priority = priorityLabel ? ` [${priorityLabel}]` : "";
  const completedAt = state.completed_at as string | null | undefined;
  const completion =
    completedAt && (state.status === "completed" || state.status === "cancelled")
      ? ` — completed ${formatDate(new Date(completedAt))}`
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

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ─── Entity → SearchResult adapter ──────────────

async function mergeEntitySources(
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

  // Resolve parent entity for each comment so the AI sees "comment on ENG-423"
  // instead of an orphaned comment snippet. Batched by unique entity_id so
  // N comments on the same ticket cost 1 lookup.
  const parentIds = Array.from(
    new Set(commentResults.map((r) => r.comment.entity_id)),
  );
  const parents = await Promise.all(
    parentIds.map((id) => EntityRepository.findById(id)),
  );
  const parentById = new Map<string, { external_id: string; title: string }>();
  parents.forEach((p) => {
    if (p) parentById.set(p.id, { external_id: p.external_id, title: p.title });
  });

  for (const r of commentResults) {
    const key = `comment:${r.comment.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parent = parentById.get(r.comment.entity_id);
    const parentTag = parent ? `[comment on ${parent.external_id} — ${parent.title}]` : "[comment]";
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

function entityToSearchResult(r: EntitySearchResult): SearchResult {
  const state = r.entity.state as Record<string, any>;
  const statusLabel = state.status_name ?? state.status ?? "";
  const assigneeName = state.assignee_name ?? "unknown";
  const completedAt = state.completed_at as string | null | undefined;

  // Header summarises the row's live facts in one line so the AI has an
  // unambiguous signal for questions like "who done X?" and "is Y done?".
  const parts: string[] = [r.entity.external_id];
  if (statusLabel) parts.push(`status: ${statusLabel}`);
  if (assigneeName && assigneeName !== "unknown") {
    parts.push(`assignee: ${assigneeName}`);
  }
  if (completedAt && (state.status === "completed" || state.status === "cancelled")) {
    parts.push(`completed: ${new Date(completedAt).toISOString().slice(0, 10)}`);
  }
  if (state.priority_label) parts.push(`priority: ${state.priority_label}`);
  const header = `[${parts.join(" | ")}]`;

  const content = `${header} ${r.entity.title}\n${r.entity.body}`;

  return {
    message: {
      id: `entity:${r.entity.id}`,
      workspace_id: r.entity.workspace_id,
      integration_id: r.entity.integration_id,
      source: "linear",
      source_message_id: r.entity.external_id,
      user_name: assigneeName,
      user_id: state.assignee_id ?? "",
      chat_id: r.entity.external_id,
      chat_name: state.project_name ?? r.entity.type,
      content,
      timestamp: r.entity.external_updated_at,
      embedding: null,
      created_at: r.entity.external_updated_at,
    },
    similarity: r.similarity,
  };
}

function hydrateFromSearch(r: EntitySearchResult): Entity {
  return {
    id: r.entity.id,
    workspace_id: r.entity.workspace_id,
    integration_id: r.entity.integration_id,
    type: r.entity.type,
    external_id: r.entity.external_id,
    external_url: r.entity.external_url,
    title: r.entity.title,
    body: r.entity.body,
    state: r.entity.state,
    participants: [],
    content_hash: "",
    external_created_at: r.entity.external_updated_at,
    external_updated_at: r.entity.external_updated_at,
    embedding: null,
    created_at: r.entity.external_updated_at,
    updated_at: r.entity.external_updated_at,
  };
}
