import { getAIProvider } from "../providers";
import { SYSTEM_PROMPT } from "../lib/constants/app.constants";
import { SearchResult } from "../lib/types";
import { RerankOptions, RerankResult } from "../lib/types/ai.types";

/**
 * AI Service — provider-agnostic AI operations.
 *
 * Uses whichever provider is configured in AI_PROVIDER env var.
 * Set AI_PROVIDER=openai for OpenAI, AI_PROVIDER=xai for Grok.
 * No code changes needed to switch — just change the env var.
 */
export const AIService = {
  /**
   * Generate embedding vector for a text string.
   * Dimensions depend on the active provider's config.
   */
  async createEmbedding(text: string): Promise<number[]> {
    const provider = getAIProvider();
    return provider.createEmbedding(text);
  },

  /**
   * Generate an answer from context messages.
   * Sends relevant messages as context + the user's question to the LLM.
   */
  async generateAnswer(
    question: string,
    searchResults: SearchResult[],
  ): Promise<string> {
    const provider = getAIProvider();

    // Sort results chronologically (oldest → newest) so LLM reads as a timeline
    const sorted = [...searchResults].sort(
      (a, b) =>
        new Date(a.message.timestamp).getTime() -
        new Date(b.message.timestamp).getTime(),
    );

    // Build context with full datetime for temporal reasoning
    const contextMessages = sorted
      .map((result, index) => {
        const msg = result.message;
        const datetime = new Date(msg.timestamp).toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        return `[${index + 1}] [${datetime}] "${msg.content}" — ${msg.user_name} via ${msg.source}`;
      })
      .join("\n");

    const userPrompt =
      contextMessages.length > 0
        ? `Context messages from company conversations:\n${contextMessages}\n\nQuestion: ${question}`
        : `No relevant context found in company conversations.\n\nQuestion: ${question}`;

    return provider.generateChatCompletion(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.3,
      maxTokens: 500,
    });
  },

  /**
   * Rerank search results by relevance to the query.
   * Falls back to original order if the provider doesn't support reranking.
   */
  async rerank(
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<RerankResult[]> {
    const provider = getAIProvider();
    return provider.rerank(query, documents, options);
  },

  /**
   * Check if the current provider supports reranking.
   */
  supportsRerank(): boolean {
    const provider = getAIProvider();
    return provider.supportsRerank;
  },
};
