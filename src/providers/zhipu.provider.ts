import OpenAI from "openai";
import {
  AIProvider,
  AIProviderConfig,
  ChatCompletionOptions,
  RerankOptions,
  RerankResult,
} from "../lib/types/ai.types";

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

  async createEmbedding(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.config.embeddingModel,
      input: text,
    });

    return response.data[0].embedding;
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: ChatCompletionOptions = {},
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.config.chatModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 500,
    });

    return (
      response.choices[0]?.message?.content || "I couldn't generate an answer."
    );
  }

  async rerank(
    _query: string,
    documents: string[],
    _options: RerankOptions = {},
  ): Promise<RerankResult[]> {
    // Zhipu doesn't support rerank — return original order
    return documents.map((_, index) => ({ index, relevanceScore: 1 }));
  }
}
