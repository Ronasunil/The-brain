import OpenAI from "openai";
import {
  AIProvider,
  AIProviderResult,
  AIProviderConfig,
  ChatCompletionOptions,
  RerankOptions,
  RerankResult,
} from "../lib/types/ai.types";

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Zhipu AI Provider (z.ai) — GLM models.
 *
 * Zhipu AI's API is OpenAI-compatible, so we reuse the OpenAI SDK
 * with a different baseURL (https://open.bigmodel.cn/api/paas/v4/).
 *
 * Models:
 *   Embedding: embedding-3 (2048 dimensions)
 *   Chat: glm-4-flash, glm-4, glm-4-plus
 */
export class ZhipuProvider implements AIProvider {
  readonly name = "zhipu";
  readonly supportsRerank = false;
  private client: OpenAI;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || "https://open.bigmodel.cn/api/paas/v4/",
    });
  }

  async createEmbedding(text: string): Promise<AIProviderResult<number[]>> {
    const response = await this.client.embeddings.create({
      model: this.config.embeddingModel,
      input: text,
    });

    const usage = response.usage as { prompt_tokens?: number; total_tokens?: number } | undefined;
    const inputTokens = usage?.prompt_tokens ?? estimateTokens(text);
    return {
      value: response.data[0].embedding,
      provider: this.name,
      model: this.config.embeddingModel,
      operation: "embedding",
      usage: {
        inputTokens,
        outputTokens: 0,
        totalTokens: usage?.total_tokens ?? inputTokens,
        approximate: !usage,
      },
    };
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: ChatCompletionOptions = {},
  ): Promise<AIProviderResult<string>> {
    const response = await this.client.chat.completions.create({
      model: this.config.chatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 500,
    });

    const text =
      response.choices[0]?.message?.content || "I couldn't generate an answer.";
    const usage = response.usage;
    const inputTokens =
      usage?.prompt_tokens ?? estimateTokens(`${systemPrompt}\n${userPrompt}`);
    const outputTokens = usage?.completion_tokens ?? estimateTokens(text);
    return {
      value: text,
      provider: this.name,
      model: this.config.chatModel,
      operation: "chat_completion",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
        approximate: !usage,
      },
    };
  }

  async rerank(
    _query: string,
    documents: string[],
    _options: RerankOptions = {},
  ): Promise<AIProviderResult<RerankResult[]>> {
    // Zhipu doesn't support rerank — return original order
    return {
      value: documents.map((_, index) => ({ index, relevanceScore: 1 })),
      provider: this.name,
      model: "none",
      operation: "rerank",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      metadata: { skipped: true },
    };
  }
}
