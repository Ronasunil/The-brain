import { MessageRepository } from "../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
import { AIService } from "./ai.service";
import { AggregationService } from "./aggregation.service";
import { classifyQuestion } from "./query-router";
import { BrainAnswer, SearchResult } from "../lib/types";
import { EntitySearchResult, Entity } from "../lib/types/entity.types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
  RERANK_INITIAL_FETCH,
  RERANK_MODEL,
  RERANK_TOP_N,
  FULLTEXT_SEARCH_LIMIT,
  MANUAL_RESERVED_SLOTS,
} from "../lib/constants/app.constants";

/**
 * Query Service — the brain's query pipeline.
 *
 * Flow:
 * 1. User asks a question
 * 2. Generate embedding of the question
 * 3. Hybrid search: cosine (semantic) + full-text (keyword) in parallel
 * 4. Merge and deduplicate results
 * 5. Rerank with Cohere rerank (if available)
 * 6. Send relevant context to AI
 * 7. Return structured answer with sources
 */
export const QueryService = {
  /**
   * Answer a question using the company's stored knowledge.
   * Scoped to a workspace; optionally narrowed to a single integration.
   */
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

    // 2. Pre-fetch manual facts + run message AND entity searches in parallel.
    //    Entities (Linear tickets) and their comments are first-class sources.
    const fetchCount = useRerank ? RERANK_INITIAL_FETCH : MAX_SEARCH_RESULTS;
    const [
      manualResults,
      cosineResults,
      fulltextResults,
      entityCosine,
      entityFullText,
      commentResults,
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
      ),
      EntityRepository.searchFullText(
        question,
        workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      ),
      EntityCommentRepository.searchSimilar(
        queryEmbedding,
        workspaceId,
        MAX_SEARCH_RESULTS,
        similarityThreshold,
      ),
    ]);

    // Fold entity + comment results into SearchResult shape so the existing
    // downstream rerank/merge/prompt pipeline treats them uniformly.
    const entityAsResults = await mergeEntitySources(
      entityCosine,
      entityFullText,
      commentResults,
    );

    // 3. Merge and deduplicate general results (cosine takes priority).
    //    Entity and comment results are folded in alongside messages.
    const mergedMessages = this.mergeResults(cosineResults, fulltextResults);
    const merged = this.mergeResults(mergedMessages, entityAsResults);

    // 4. Rerank general results if provider supports it
    let generalResults: SearchResult[];
    if (useRerank && merged.length > 0) {
      const documents = merged.map((r) => r.message.content);
      const reranked = await AIService.rerank(question, documents, {
        topN: RERANK_TOP_N,
        model: RERANK_MODEL,
      });

      generalResults = reranked.map((r) => ({
        ...merged[r.index],
        similarity: r.relevanceScore,
      }));
    } else {
      generalResults = merged.slice(0, MAX_SEARCH_RESULTS);
    }

    // 5. Manual slots first, then general (dedup by id to avoid showing a fact twice)
    const manualIds = new Set(manualResults.map((r) => r.message.id));
    const dedupedGeneral = generalResults.filter(
      (r) => !manualIds.has(r.message.id),
    );
    const finalResults: SearchResult[] = [
      ...manualResults,
      ...dedupedGeneral.slice(0, MAX_SEARCH_RESULTS - manualResults.length),
    ];

    // 6. Generate AI answer — pass manual facts separately so they get the
    //    ground-truth authority prompt instruction
    const answer = await AIService.generateAnswer(
      question,
      finalResults,
      manualResults.length > 0 ? manualResults : undefined,
    );

    // 7. Build response with sources
    return {
      answer,
      sources: finalResults.map((result) => ({
        content: result.message.content,
        user_name: result.message.user_name,
        source: result.message.source,
        timestamp: result.message.timestamp,
        similarity: Math.round(result.similarity * 100) / 100,
      })),
    };
  },

  /**
   * Merge cosine and full-text results, deduplicating by message ID.
   * Cosine results come first (they already have similarity scores).
   * Full-text results are appended if not already present.
   */
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
