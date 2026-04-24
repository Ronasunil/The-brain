import { AIService } from "./ai.service";
import { SearchResult, CodeSearchResult } from "../lib/types";
import { EntitySearchResult } from "../lib/types/entity.types";
import {
  MAX_SEARCH_RESULTS,
  CODE_SEARCH_RESULTS,
  RERANK_MODEL,
  RERANK_TOP_N,
} from "../lib/constants/app.constants";

/**
 * Retrieval Merger
 *
 * Final dedupe + rerank step in the hybrid brain pipeline. Sits between the
 * per-source retrievers (messages, entities, comments, code) and the LLM
 * synthesizer. Takes already-merged per-source results, unifies them into a
 * single ranking pool, and returns the top-N slots for prompt context.
 *
 * Extracted from the legacy QueryService.ask so BrainService can reuse it
 * without duplicating merge logic.
 */

export interface UnifiedResult {
  id: string;
  content: string;
  similarity: number;
  origin: "message" | "code";
  messageResult?: SearchResult;
  codeResult?: CodeSearchResult;
}

/**
 * Per-source retrieval results fed into the merger. Each list is already
 * internally deduped (cosine vs fulltext within the same source).
 */
export interface RetrievalSources {
  /** Reserved-slot manual facts — always passed through, never reranked. */
  manualResults?: SearchResult[];
  /** Messages (chat/telegram/web) already merged cosine+FTS. */
  messages?: SearchResult[];
  /** Entities + comments already resolved into SearchResult adapters. */
  entities?: SearchResult[];
  /** Code chunks already merged cosine+FTS. */
  code?: CodeSearchResult[];
}

export interface MergedResults {
  /** Manual-facts pass-through, rendered as ground-truth in the prompt. */
  manualResults: SearchResult[];
  /** Reranked / dedup'd pool for the synthesizer. */
  ranked: UnifiedResult[];
}

/**
 * Merge all sources into one ranking pool, rerank with Cohere if available
 * (otherwise similarity-sort), dedupe against the manual-facts reserved
 * slots, and return the top-N for prompt context.
 */
export async function mergeAndRerank(
  question: string,
  sources: RetrievalSources,
  totalSlots: number = MAX_SEARCH_RESULTS + CODE_SEARCH_RESULTS,
): Promise<MergedResults> {
  const useRerank = AIService.supportsRerank();

  const allUnified: UnifiedResult[] = [
    ...(sources.messages ?? []).map(messageToUnified),
    ...(sources.entities ?? []).map(messageToUnified),
    ...(sources.code ?? []).map(codeToUnified),
  ];

  let rankedUnified: UnifiedResult[];
  if (useRerank && allUnified.length > 0) {
    const documents = allUnified.map((r) => r.content);
    const reranked = await AIService.rerank(question, documents, {
      topN: Math.min(RERANK_TOP_N, allUnified.length),
      model: RERANK_MODEL,
    });
    rankedUnified = reranked.map((r) => ({
      ...(allUnified[r.index] as UnifiedResult),
      similarity: r.relevanceScore,
    }));
  } else {
    rankedUnified = allUnified
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, totalSlots);
  }

  const manualResults = sources.manualResults ?? [];
  const manualIds = new Set(manualResults.map((r) => r.message.id));
  const dedupedRanked = rankedUnified.filter((r) => !manualIds.has(r.id));
  const finalUnified = dedupedRanked.slice(
    0,
    Math.max(0, totalSlots - manualResults.length),
  );

  return { manualResults, ranked: finalUnified };
}

export function codeToUnified(result: CodeSearchResult): UnifiedResult {
  return {
    id: result.chunk.id,
    content: result.chunk.content,
    similarity: result.similarity,
    origin: "code",
    codeResult: result,
  };
}

export function messageToUnified(result: SearchResult): UnifiedResult {
  return {
    id: result.message.id,
    content: result.message.content,
    similarity: result.similarity,
    origin: "message",
    messageResult: result,
  };
}

/**
 * Adapt an EntitySearchResult into a SearchResult so entities and messages
 * live in the same ranking pool. The content field carries a one-line
 * header so the LLM has an unambiguous signal for structural questions.
 */
export function entityToSearchResult(r: EntitySearchResult): SearchResult {
  const state = r.entity.state as Record<string, any>;
  const statusLabel = state.status_name ?? state.status ?? "";
  const assigneeName = state.assignee_name ?? "unknown";
  const completedAt = state.completed_at as string | null | undefined;

  const parts: string[] = [r.entity.external_id];
  if (statusLabel) parts.push(`status: ${statusLabel}`);
  if (assigneeName && assigneeName !== "unknown") {
    parts.push(`assignee: ${assigneeName}`);
  }
  if (
    completedAt &&
    (state.status === "completed" || state.status === "cancelled")
  ) {
    parts.push(
      `completed: ${new Date(completedAt).toISOString().slice(0, 10)}`,
    );
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
