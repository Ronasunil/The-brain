import { MessageRepository } from "../db/message.repository";
import { AIService } from "./ai.service";
import { CreateMessageInput, StoredMessage } from "../lib/types";
import { AgentOrchestrator } from "./operational-memory/orchestrator";

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
      const embedding = await AIService.createEmbedding(input.content, {
        workspaceId: input.workspace_id,
        source: `message_ingest:${input.source}`,
        metadata: { messageId: message.id },
      });
      await MessageRepository.updateEmbedding(message.id, embedding);
      console.log(`✅ Embedded message ${message.id} from ${input.source}`);
    } catch (error) {
      // Log but don't fail — message is stored, embedding can retry later
      console.error(`⚠️ Failed to embed message ${message.id}:`, error);
    }

    void AgentOrchestrator.recordEvent({
      workspaceId: input.workspace_id,
      type: "message_ingested",
      subjectRefs: [{ type: "message", id: message.id }],
      payload: {
        content: input.content,
        source: input.source,
        user_id: input.user_id,
        user_name: input.user_name,
        chat_name: input.chat_name,
      },
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Operational message event skipped: ${msg}`);
    });

    return message;
  },

  /**
   * Get total stored messages for a workspace.
   */
  async getCount(workspaceId: string): Promise<number> {
    return MessageRepository.count(workspaceId);
  },
};
