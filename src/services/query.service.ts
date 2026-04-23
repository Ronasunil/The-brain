import { MessageRepository } from "../db/message.repository";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { AIService } from "./ai.service";
import {
  BrainAnswer,
  BrainAnswerSource,
  SearchResult,
  CodeSearchResult,
} from "../lib/types";
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
    const useRerank = AIService.supportsRerank();
    const queryEmbedding = await AIService.createEmbedding(question);

    const fetchCount = useRerank ? RERANK_INITIAL_FETCH : MAX_SEARCH_RESULTS;
    const [
      manualResults,
      cosineResults,
      fulltextResults,
      codeCosineResults,
      codeFulltextResults,
    ] = await Promise.all([
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
      CodeChunkRepository.searchSimilar(
        queryEmbedding,
        workspaceId,
        fetchCount,
        MIN_SIMILARITY_THRESHOLD,
      ),
      CodeChunkRepository.searchFullText(
        question,
        workspaceId,
        FULLTEXT_SEARCH_LIMIT,
      ),
    ]);

    const mergedMessages = this.mergeResults(cosineResults, fulltextResults);
    const mergedCode = this.mergeCodeResults(
      codeCosineResults,
      codeFulltextResults,
    );

    const allUnified: UnifiedResult[] = [
      ...mergedMessages.map(messageToUnified),
      ...mergedCode.map(codeToUnified),
    ];

    let rankedUnified: UnifiedResult[];
    if (useRerank && allUnified.length > 0) {
      const documents = allUnified.map((r) => r.content);
      const reranked = await AIService.rerank(question, documents, {
        topN: RERANK_TOP_N,
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
