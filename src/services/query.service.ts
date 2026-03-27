import { MessageRepository } from "../db/message.repository";
import { CodebaseRepository } from "../db/codebase.repository";
import { AIService } from "./ai.service";
import {
  BrainAnswer,
  SearchResult,
  UnifiedSearchResult,
} from "../lib/types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
  RERANK_INITIAL_FETCH,
  RERANK_MODEL,
  RERANK_TOP_N,
  FULLTEXT_SEARCH_LIMIT,
} from "../lib/constants/app.constants";

const MAX_CONTEXT_CHARS = 15000;

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
  /**
   * Answer a question using the company's stored knowledge.
   * Searches both conversation messages and code chunks.
   */
  async ask(question: string, workspaceId: string): Promise<BrainAnswer> {
    const useRerank = AIService.supportsRerank();

    // 1. Generate embedding for the question
    const queryEmbedding = await AIService.createEmbedding(question);

    // 2. Hybrid search across BOTH tables in parallel
    const fetchCount = useRerank ? RERANK_INITIAL_FETCH : MAX_SEARCH_RESULTS;
    const [
      msgCosine,
      msgFulltext,
      codeCosine,
      codeFulltext,
    ] = await Promise.all([
      MessageRepository.searchSimilar(
        queryEmbedding,
        workspaceId,
        fetchCount,
        MIN_SIMILARITY_THRESHOLD,
      ),
      MessageRepository.searchFullText(
        question,
        workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      ),
      CodebaseRepository.searchSimilar(
        queryEmbedding,
        workspaceId,
        fetchCount,
        MIN_SIMILARITY_THRESHOLD,
      ),
      CodebaseRepository.searchFullText(
        question,
        workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      ),
    ]);

    // 3. Merge within each table, then unify
    const msgMerged = this.mergeMessageResults(msgCosine, msgFulltext);
    const codeMerged = this.mergeCodeResults(codeCosine, codeFulltext);

    const unified: UnifiedSearchResult[] = [
      ...msgMerged.map(
        (r): UnifiedSearchResult => ({
          item: { kind: "message", data: r.message },
          similarity: r.similarity,
        }),
      ),
      ...codeMerged.map(
        (r): UnifiedSearchResult => ({
          item: { kind: "code", data: r.chunk },
          similarity: r.similarity,
        }),
      ),
    ];

    // 4. Rerank if provider supports it
    let finalResults: UnifiedSearchResult[];
    if (useRerank && unified.length > 0) {
      const documents = unified.map((r) =>
        r.item.kind === "message" ? r.item.data.content : r.item.data.content,
      );
      const reranked = await AIService.rerank(question, documents, {
        topN: RERANK_TOP_N,
        model: RERANK_MODEL,
      });

      finalResults = reranked.map((r) => ({
        ...unified[r.index],
        similarity: r.relevanceScore,
      }));
    } else {
      // Without reranking, sort by similarity descending and take top N
      finalResults = unified
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SEARCH_RESULTS);
    }

    // 5. Apply context budget — trim list if total chars exceed limit
    finalResults = this.applyContextBudget(finalResults, MAX_CONTEXT_CHARS);

    // 6. Generate AI answer from unified context
    const answer = await AIService.generateAnswer(question, finalResults);

    // 7. Build response with sources
    return {
      answer,
      sources: finalResults.map((result) => {
        if (result.item.kind === "message") {
          const msg = result.item.data;
          return {
            content: msg.content,
            user_name: msg.user_name,
            source: msg.source,
            timestamp: msg.timestamp,
            similarity: Math.round(result.similarity * 100) / 100,
          };
        } else {
          const chunk = result.item.data;
          return {
            content: chunk.content,
            user_name: "codebase",
            source: "code",
            timestamp: chunk.created_at,
            similarity: Math.round(result.similarity * 100) / 100,
            file_path: chunk.file_path,
          };
        }
      }),
    };
  },

  /**
   * Merge cosine and full-text message results, deduplicating by ID.
   */
  mergeMessageResults(
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

  /**
   * Merge cosine and full-text code chunk results, deduplicating by ID.
   */
  mergeCodeResults(
    cosineResults: { chunk: any; similarity: number }[],
    fulltextResults: { chunk: any; similarity: number }[],
  ): { chunk: any; similarity: number }[] {
    const seen = new Set<string>();
    const merged: { chunk: any; similarity: number }[] = [];

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

  /**
   * Trim the results list so total content doesn't exceed maxChars.
   * Keeps results in order (most relevant first), drops from the end.
   */
  applyContextBudget(
    results: UnifiedSearchResult[],
    maxChars: number,
  ): UnifiedSearchResult[] {
    let totalChars = 0;
    const budgeted: UnifiedSearchResult[] = [];

    for (const result of results) {
      const content =
        result.item.kind === "message"
          ? result.item.data.content
          : result.item.data.content;
      if (totalChars + content.length > maxChars && budgeted.length > 0) {
        break;
      }
      totalChars += content.length;
      budgeted.push(result);
    }

    return budgeted;
  },
};
