import { MessageRepository } from "../db/message.repository";
import { AIService } from "./ai.service";
import {
  EMBEDDING_WORKER_INTERVAL_MS,
  EMBEDDING_WORKER_BATCH_SIZE,
  MIN_MESSAGE_LENGTH,
} from "../lib/constants/import.constants";

let workerInterval: ReturnType<typeof setInterval> | null = null;
let isProcessing = false;

/**
 * Background Embedding Worker.
 *
 * Runs on a setInterval loop inside the same Node.js process.
 * Picks up messages that have no embedding yet and generates them in batches.
 *
 * Why:
 * - Bulk imports store messages without embeddings (fast insert)
 * - This worker fills in embeddings gradually in the background
 * - API stays responsive during large imports
 */
export const EmbeddingWorker = {
  /**
   * Start the background worker.
   */
  start(): void {
    if (workerInterval) return; // Already running

    workerInterval = setInterval(async () => {
      if (isProcessing) return; // Skip if previous batch is still running
      isProcessing = true;

      try {
        await this.processBatch();
      } catch (error) {
        console.error("⚠️ Embedding worker error:", error);
      } finally {
        isProcessing = false;
      }
    }, EMBEDDING_WORKER_INTERVAL_MS);

    console.log(
      `🔄 Embedding worker started (every ${EMBEDDING_WORKER_INTERVAL_MS / 1000}s, batch size ${EMBEDDING_WORKER_BATCH_SIZE})`,
    );
  },

  /**
   * Process one batch of unembedded messages.
   */
  async processBatch(): Promise<number> {
    const messages = await MessageRepository.getUnembedded(
      EMBEDDING_WORKER_BATCH_SIZE,
    );

    if (messages.length === 0) return 0;

    let embedded = 0;

    for (const msg of messages) {
      // Skip messages too short to embed meaningfully
      if (!msg.content || msg.content.trim().length < MIN_MESSAGE_LENGTH) {
        continue;
      }

      try {
        const embedding = await AIService.createEmbedding(msg.content);
        await MessageRepository.updateEmbedding(msg.id, embedding);
        embedded++;
      } catch (error) {
        console.error(`⚠️ Failed to embed message ${msg.id}:`, error);
        // Continue with next message — don't fail the whole batch
      }
    }

    if (embedded > 0) {
      console.log(`🔄 Embedded ${embedded}/${messages.length} messages`);
    }

    return embedded;
  },

  /**
   * Stop the background worker.
   */
  stop(): void {
    if (workerInterval) {
      clearInterval(workerInterval);
      workerInterval = null;
      console.log("🛑 Embedding worker stopped");
    }
  },
};
