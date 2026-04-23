import { MessageRepository } from "../db/message.repository";
import {
  EntityRepository,
  EntityCommentRepository,
} from "../db/entity.repository";
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
   * Process one batch of unembedded rows across messages, entities, and
   * entity_comments. The batch budget is shared across all three sources so
   * a big backfill on one source doesn't starve the others.
   */
  async processBatch(): Promise<number> {
    const budget = EMBEDDING_WORKER_BATCH_SIZE;
    // Split budget so each source has a chance to drain. Messages get the
    // largest share (highest typical volume from Telegram imports).
    const msgBudget = Math.max(1, Math.floor(budget * 0.6));
    const entityBudget = Math.max(1, Math.floor(budget * 0.2));
    const commentBudget = Math.max(1, Math.floor(budget * 0.2));

    const [messages, entities, comments] = await Promise.all([
      MessageRepository.getUnembedded(msgBudget),
      EntityRepository.getUnembedded(entityBudget),
      EntityCommentRepository.getUnembedded(commentBudget),
    ]);

    if (messages.length + entities.length + comments.length === 0) return 0;

    let embedded = 0;

    for (const msg of messages) {
      if (!msg.content || msg.content.trim().length < MIN_MESSAGE_LENGTH) {
        continue;
      }
      try {
        const embedding = await AIService.createEmbedding(msg.content);
        await MessageRepository.updateEmbedding(msg.id, embedding);
        embedded++;
      } catch (error) {
        console.error(`⚠️ Failed to embed message ${msg.id}:`, error);
      }
    }

    for (const entity of entities) {
      const text = `${entity.title}\n${entity.body}`.trim();
      if (text.length < MIN_MESSAGE_LENGTH) continue;
      try {
        const embedding = await AIService.createEmbedding(text);
        await EntityRepository.updateEmbedding(entity.id, embedding);
        embedded++;
      } catch (error) {
        console.error(`⚠️ Failed to embed entity ${entity.id}:`, error);
      }
    }

    for (const comment of comments) {
      if (!comment.content || comment.content.trim().length < MIN_MESSAGE_LENGTH) {
        continue;
      }
      try {
        const embedding = await AIService.createEmbedding(comment.content);
        await EntityCommentRepository.updateEmbedding(comment.id, embedding);
        embedded++;
      } catch (error) {
        console.error(`⚠️ Failed to embed comment ${comment.id}:`, error);
      }
    }

    if (embedded > 0) {
      const total = messages.length + entities.length + comments.length;
      console.log(
        `🔄 Embedded ${embedded}/${total} rows (msgs ${messages.length}, entities ${entities.length}, comments ${comments.length})`,
      );
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
