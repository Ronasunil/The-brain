import { MessageRepository } from "../db/message.repository";
import { AIService } from "./ai.service";
import { CreateMessageInput, StoredMessage } from "../lib/types";

/**
 * Message Service — handles message ingestion.
 * Stores raw messages and generates embeddings.
 */
export const MessageService = {
  /**
   * Ingest a new message: store in DB + generate embedding.
   * This is the main entry point for all incoming messages.
   */
  async ingest(input: CreateMessageInput): Promise<StoredMessage> {
    // Skip empty or very short messages
    if (!input.content || input.content.trim().length < 3) {
      throw new Error("Message content too short to process");
    }

    // 1. Store raw message in DB
    const message = await MessageRepository.create(input);

    // 2. Generate embedding (sync for V1 — no queue)
    try {
      const embedding = await AIService.createEmbedding(input.content);
      await MessageRepository.updateEmbedding(message.id, embedding);
      console.log(`✅ Embedded message ${message.id} from ${input.source}`);
    } catch (error) {
      // Log but don't fail — message is stored, embedding can retry later
      console.error(`⚠️ Failed to embed message ${message.id}:`, error);
    }

    return message;
  },

  /**
   * Get total stored messages for a workspace.
   */
  async getCount(workspaceId: string): Promise<number> {
    return MessageRepository.count(workspaceId);
  },
};
