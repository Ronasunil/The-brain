import OpenAI from "openai";
import {
  AIProvider,
  AIProviderConfig,
  ChatCompletionOptions,
} from "../lib/types/ai.types";

/**
 * OpenAI Provider — uses the official OpenAI SDK.
 * Models: text-embedding-3-small, gpt-4o-mini, etc.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  private client: OpenAI;
  private config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL && { baseURL: config.baseURL }),
    });
  }

  async createEmbedding(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: this.config.embeddingModel,
      input: text,
      dimensions: this.config.embeddingDimensions,
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
}
