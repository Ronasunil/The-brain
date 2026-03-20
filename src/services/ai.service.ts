import OpenAI from "openai";
import { env } from "../config/env";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  CHAT_MODEL,
  SYSTEM_PROMPT,
} from "../lib/constants/app.constants";
import { SearchResult } from "../lib/types";

let openai: OpenAI;

function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openai;
}

/**
 * AI Service — handles all OpenAI interactions.
 * Embeddings + chat completions.
 */
export const AIService = {
  /**
   * Generate embedding vector for a text string.
   * Uses text-embedding-3-small (1536 dimensions).
   */
  async createEmbedding(text: string): Promise<number[]> {
    const client = getOpenAI();

    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    return response.data[0].embedding;
  },

  /**
   * Generate an answer from context messages.
   * Sends relevant messages as context + the user's question to the LLM.
   */
  async generateAnswer(question: string, searchResults: SearchResult[]): Promise<string> {
    const client = getOpenAI();

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

    const userPrompt = contextMessages.length > 0
      ? `Context messages from company conversations:\n${contextMessages}\n\nQuestion: ${question}`
      : `No relevant context found in company conversations.\n\nQuestion: ${question}`;

    const response = await client.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content || "I couldn't generate an answer.";
  },
};
