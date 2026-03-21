import { CohereClient } from "cohere-ai";
import {
  AIProvider,
  AIProviderConfig,
  ChatCompletionOptions,
} from "../lib/types/ai.types";

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
  private client: CohereClient;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.client = new CohereClient({
      token: config.apiKey,
    });
  }

  async createEmbedding(text: string): Promise<number[]> {
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
      return embeddings.float[0];
    }

    throw new Error("Unexpected embedding response format from Cohere");
  }

  async generateChatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: ChatCompletionOptions = {},
  ): Promise<string> {
    const response = await this.client.chat({
      model: this.config.chatModel,
      message: userPrompt,
      preamble: systemPrompt,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? 500,
    });

    return response.text || "I couldn't generate an answer.";
  }
}
