import { getAIProvider } from "../providers";
import { SYSTEM_PROMPT } from "../lib/constants/app.constants";
import { SearchResult } from "../lib/types";

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

    // Build context from search results
    const contextMessages = searchResults
      .map((result, index) => {
        const msg = result.message;
        const date = new Date(msg.timestamp).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        return `[${index + 1}] "${msg.content}" — ${msg.user_name} via ${msg.source} (${date})`;
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
};
