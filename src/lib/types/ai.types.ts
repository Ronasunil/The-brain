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

  /** Whether this provider supports reranking */
  readonly supportsRerank: boolean;

  /**
   * Generate an embedding vector for a text string.
   * Returns a number array matching the configured dimensions.
   */
  createEmbedding(text: string): Promise<AIProviderResult<number[]>>;

  /**
   * Generate a chat completion from a system prompt + user message.
   * Returns the assistant's response text.
   */
  generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options?: ChatCompletionOptions,
  ): Promise<AIProviderResult<string>>;

  /**
   * Rerank documents by relevance to a query.
   * Returns reordered indices with relevance scores.
   * Only supported by Cohere — other providers return documents unchanged.
   */
  rerank(
    query: string,
    documents: string[],
    options?: RerankOptions,
  ): Promise<AIProviderResult<RerankResult[]>>;
}

export type TokenUsageOperation =
  | "chat_completion"
  | "embedding"
  | "rerank"
  | "query_planning"
  | "other";

export interface TokenUsageTracking {
  workspaceId?: string;
  userId?: string;
  source?: string;
  operation?: TokenUsageOperation;
  metadata?: Record<string, unknown>;
}

export interface TokenUsageCounts {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  approximate?: boolean;
}

export interface AIProviderResult<T> {
  value: T;
  provider: string;
  model: string;
  operation: TokenUsageOperation;
  usage: TokenUsageCounts;
  metadata?: Record<string, unknown>;
}

/**
 * Options for chat completions — same across all providers.
 */
export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Options for reranking.
 */
export interface RerankOptions {
  topN?: number;
  model?: string;
}

/**
 * A single rerank result — maps back to the original document index.
 */
export interface RerankResult {
  index: number;
  relevanceScore: number;
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
