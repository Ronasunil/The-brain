import { getAIProvider } from "../providers";
import { SYSTEM_PROMPT } from "../lib/constants/app.constants";
import { UnifiedSearchResult } from "../lib/types";
import { RerankOptions, RerankResult } from "../lib/types/ai.types";

/**
 * AI Service — provider-agnostic AI operations.
 *
 * Uses whichever provider is configured in AI_PROVIDER env var.
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
   * Generate an answer from unified context (messages + code chunks).
   * Formats each result type differently for the LLM.
   */
  async generateAnswer(
    question: string,
    searchResults: UnifiedSearchResult[],
  ): Promise<string> {
    const provider = getAIProvider();

    // Separate message and code results for formatting
    const messageResults = searchResults.filter(
      (r) => r.item.kind === "message",
    );
    const codeResults = searchResults.filter((r) => r.item.kind === "code");

    // Sort messages chronologically (oldest → newest)
    const sortedMessages = [...messageResults].sort((a, b) => {
      const aTime =
        a.item.kind === "message"
          ? new Date(a.item.data.timestamp).getTime()
          : 0;
      const bTime =
        b.item.kind === "message"
          ? new Date(b.item.data.timestamp).getTime()
          : 0;
      return aTime - bTime;
    });

    // Format message context
    let counter = 1;
    const messageContext = sortedMessages
      .map((result) => {
        if (result.item.kind !== "message") return "";
        const msg = result.item.data;
        const datetime = new Date(msg.timestamp).toLocaleString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        return `[${counter++}] [${datetime}] "${msg.content}" — ${msg.user_name} via ${msg.source}`;
      })
      .filter(Boolean)
      .join("\n");

    // Format code context
    const codeContext = codeResults
      .map((result) => {
        if (result.item.kind !== "code") return "";
        const chunk = result.item.data;
        return `[CODE ${counter++}] [file: ${chunk.file_path}]\n${chunk.content}`;
      })
      .filter(Boolean)
      .join("\n\n");

    // Build combined user prompt
    const parts: string[] = [];

    if (messageContext) {
      parts.push(
        `Context messages from company conversations:\n${messageContext}`,
      );
    }

    if (codeContext) {
      parts.push(`Context from codebase:\n${codeContext}`);
    }

    if (parts.length === 0) {
      parts.push("No relevant context found in company knowledge base.");
    }

    const hasCode = codeResults.length > 0;
    const maxTokens = hasCode ? 800 : 500;

    const userPrompt = `${parts.join("\n\n")}\n\nQuestion: ${question}`;

    return provider.generateChatCompletion(SYSTEM_PROMPT, userPrompt, {
      temperature: 0.3,
      maxTokens,
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
