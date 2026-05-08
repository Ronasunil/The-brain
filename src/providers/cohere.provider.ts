import { CohereClient } from "cohere-ai";
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

function cohereInputTokens(response: any, fallback: number): number {
  return (
    response?.meta?.billedUnits?.inputTokens ??
    response?.meta?.tokens?.inputTokens ??
    fallback
  );
}

function cohereOutputTokens(response: any, fallback: number): number {
  return (
    response?.meta?.billedUnits?.outputTokens ??
    response?.meta?.tokens?.outputTokens ??
    fallback
  );
}

/**
 * Cohere Provider — uses the official Cohere SDK.
 *
 * Free tier (no credit card):
 *   - 1000 API calls/month
 *   - embed-english-v3.0 (1024 dimensions)
 *   - command-r-plus (chat)
 *
 * Docs: https://docs.cohere.com
 */
export class CohereProvider implements AIProvider {
  readonly name = "cohere";
  readonly supportsRerank = true;
  private client: CohereClient;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.client = new CohereClient({
      token: config.apiKey,
    });
  }

  async createEmbedding(text: string): Promise<AIProviderResult<number[]>> {
    const response = await this.client.embed({
      texts: [text],
      model: this.config.embeddingModel,
      inputType: "search_document",
      embeddingTypes: ["float"],
    });

    // Response shape: { embeddings: { float: [[...]] } }
    const embeddings = response.embeddings;
    if (
      embeddings &&
      typeof embeddings === "object" &&
      "float" in embeddings &&
      Array.isArray(embeddings.float)
    ) {
      const inputTokens = cohereInputTokens(response, estimateTokens(text));
      return {
        value: embeddings.float[0],
        provider: this.name,
        model: this.config.embeddingModel,
        operation: "embedding",
        usage: {
          inputTokens,
          outputTokens: 0,
          totalTokens: inputTokens,
          approximate: !response.meta,
        },
      };
    }

    throw new Error("Unexpected embedding response format from Cohere");
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: ChatCompletionOptions = {},
  ): Promise<AIProviderResult<string>> {
    const response = await this.client.chat({
      model: this.config.chatModel,
      message: userPrompt,
      preamble: systemPrompt,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? 500,
    });

    const text = response.text || "I couldn't generate an answer.";
    const inputTokens = cohereInputTokens(
      response,
      estimateTokens(`${systemPrompt}\n${userPrompt}`),
    );
    const outputTokens = cohereOutputTokens(response, estimateTokens(text));
    return {
      value: text,
      provider: this.name,
      model: this.config.chatModel,
      operation: "chat_completion",
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        approximate: !response.meta,
      },
    };
  }

  async rerank(
    query: string,
    documents: string[],
    options: RerankOptions = {},
  ): Promise<AIProviderResult<RerankResult[]>> {
    const response = await this.client.rerank({
      model: options.model || "rerank-v3.5",
      query,
      documents,
      topN: options.topN || documents.length,
    });

    const value = response.results.map((r) => ({
      index: r.index,
      relevanceScore: r.relevanceScore,
    }));
    const inputTokens = cohereInputTokens(
      response,
      estimateTokens(`${query}\n${documents.join("\n")}`),
    );
    return {
      value,
      provider: this.name,
      model: options.model || "rerank-v3.5",
      operation: "rerank",
      usage: {
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens,
        approximate: !response.meta,
      },
    };
  }
}
