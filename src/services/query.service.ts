import { MessageRepository } from "../db/message.repository";
import { AIService } from "./ai.service";
import { BrainAnswer, SearchResult } from "../lib/types";
import {
  MAX_SEARCH_RESULTS,
  MIN_SIMILARITY_THRESHOLD,
} from "../lib/constants/app.constants";

/**
 * Query Service — the brain's query pipeline.
 *
 * Flow:
 * 1. User asks a question
 * 2. Generate embedding of the question
 * 3. Search similar messages via pgvector
 * 4. Send relevant context to AI
 * 5. Return structured answer with sources
 */
export const QueryService = {
  /**
   * Answer a question using the company's stored knowledge.
   */
  async ask(question: string, workspaceId: string): Promise<BrainAnswer> {
    // 1. Generate embedding for the question
    const queryEmbedding = await AIService.createEmbedding(question);

    // 2. Search for similar messages
    const searchResults = await MessageRepository.searchSimilar(
      queryEmbedding,
      workspaceId,
      MAX_SEARCH_RESULTS,
      MIN_SIMILARITY_THRESHOLD,
    );

    // 3. Generate AI answer from context
    const answer = await AIService.generateAnswer(question, searchResults);

    console.log("Generated answer:", answer);

    // 4. Build response with sources
    return {
      answer,
      sources: searchResults.map((result) => ({
        content: result.message.content,
        user_name: result.message.user_name,
        source: result.message.source,
        timestamp: result.message.timestamp,
        similarity: Math.round(result.similarity * 100) / 100,
      })),
    };
  },
};
