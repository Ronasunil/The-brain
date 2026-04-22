import { MessageRepository } from "../db/message.repository";
import { AIService } from "./ai.service";
import { BrainAnswer, SearchResult } from "../lib/types";
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
    const useRerank = AIService.supportsRerank();

    // 1. Generate embedding for the question
    const queryEmbedding = await AIService.createEmbedding(question);

    // 2. Pre-fetch authoritative manual facts (reserved slots).
    //    Runs in parallel with the general hybrid search.
    const fetchCount = useRerank ? RERANK_INITIAL_FETCH : MAX_SEARCH_RESULTS;
    const [manualResults, cosineResults, fulltextResults] = await Promise.all([
      MessageRepository.searchManual(
        workspaceId,
        queryEmbedding,
        MANUAL_RESERVED_SLOTS,
        MIN_SIMILARITY_THRESHOLD,
        integrationId,
      ),
      MessageRepository.searchSimilar(
        queryEmbedding,
        workspaceId,
        fetchCount,
        MIN_SIMILARITY_THRESHOLD,
        integrationId,
      ),
      MessageRepository.searchFullText(
        question,
        workspaceId,
        FULLTEXT_SEARCH_LIMIT,
        integrationId,
      ),
    ]);

    // 3. Merge and deduplicate general results (cosine takes priority)
    const merged = this.mergeResults(cosineResults, fulltextResults);

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
