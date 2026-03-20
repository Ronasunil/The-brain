/**
 * AI Provider Interface.
 *
 * Every AI provider (OpenAI, xAI/Grok, Gemini, etc.) must implement this.
 * The AIService uses whichever provider is configured — swap providers
 * by changing AI_PROVIDER in .env, zero code changes needed.
 */
export interface AIProvider {
  /** Provider identifier */
  readonly name: string;

  /**
   * Generate an embedding vector for a text string.
   * Returns a number array matching the configured dimensions.
   */
  createEmbedding(text: string): Promise<number[]>;

  /**
   * Generate a chat completion from a system prompt + user message.
   * Returns the assistant's response text.
   */
  generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options?: ChatCompletionOptions,
  ): Promise<string>;
}

/**
 * Options for chat completions — same across all providers.
 */
export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Configuration for an AI provider.
 */
export interface AIProviderConfig {
  apiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chatModel: string;
  baseURL?: string;
}

/**
 * Supported AI provider names.
 */
export const AI_PROVIDERS = ["openai", "zhipu", "cohere"] as const;
export type AIProviderName = (typeof AI_PROVIDERS)[number];
