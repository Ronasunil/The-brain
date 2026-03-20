import * as fs from "fs";
import { parser } from "stream-json";
import { pick } from "stream-json/filters/Pick";
import { streamArray } from "stream-json/streamers/StreamArray";
import { MessageRepository } from "../db/message.repository";
import { CreateMessageInput } from "../lib/types";
import {
  TelegramExportMessage,
  ImportStatus,
} from "../lib/validations/import.schema";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";
import {
  IMPORT_BATCH_SIZE,
  MIN_MESSAGE_LENGTH,
} from "../lib/constants/import.constants";

// Track active import jobs (in-memory for V1)
const importJobs = new Map<string, ImportStatus>();

/**
 * Import Service — handles bulk importing messages from platform exports.
 *
 * Flow:
 * 1. Stream-parse the JSON file (no full load into memory)
 * 2. Batch messages into groups of IMPORT_BATCH_SIZE
 * 3. Bulk INSERT each batch (skip duplicates)
 * 4. Embeddings are handled separately by EmbeddingWorker
 */
export const ImportService = {
  /**
   * Import a Telegram Desktop export JSON file.
   * Streams the file so it works with large exports (100K+ messages).
   */
  async importTelegramExport(
    filePath: string,
    chatId: string,
    chatName: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<string> {
    const jobId = `import_${Date.now()}`;

    const status: ImportStatus = {
      status: "processing",
      total_parsed: 0,
      total_stored: 0,
      total_skipped: 0,
      total_embedded: 0,
      started_at: new Date(),
      completed_at: null,
      error: null,
    };

    importJobs.set(jobId, status);

    // Process in background (don't await  return job ID immediately)
    this.processFile(filePath, chatId, chatName, workspaceId, status)
      .then(() => {
        status.status = "completed";
        status.completed_at = new Date();
        console.log(
          `✅ Import ${jobId} completed: ${status.total_stored} messages stored, ${status.total_skipped} skipped`,
        );
      })
      .catch((error) => {
        status.status = "failed";
        status.completed_at = new Date();
        status.error = error.message;
        console.error(`❌ Import ${jobId} failed:`, error.message);
      });

    return jobId;
  },

  /**
   * Stream-parse and batch-insert messages from a Telegram export file.
   */
  async processFile(
    filePath: string,
    chatId: string,
    chatName: string,
    workspaceId: string,
    status: ImportStatus,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let batch: CreateMessageInput[] = [];

      const pipeline = fs
        .createReadStream(filePath)
        .pipe(parser())
        .pipe(pick({ filter: "messages" }))
        .pipe(streamArray());

      pipeline.on(
        "data",
        async ({ value }: { value: TelegramExportMessage }) => {
          // Only process text messages
          if (value.type !== "message") return;

          const text = this.extractText(value);
          if (!text || text.length < MIN_MESSAGE_LENGTH) {
            status.total_skipped++;
            return;
          }

          status.total_parsed++;

          const input: CreateMessageInput = {
            workspace_id: workspaceId,
            source: "telegram",
            source_message_id: `import_${value.id}`,
            user_name: value.from || "unknown",
            user_id: value.from_id || "",
            chat_id: chatId,
            chat_name: chatName,
            content: text,
            timestamp: new Date(value.date),
          };

          batch.push(input);

          // Flush batch when full
          if (batch.length >= IMPORT_BATCH_SIZE) {
            pipeline.pause();
            try {
              const stored = await MessageRepository.createBatch(batch);
              status.total_stored += stored;
            } catch (error) {
              console.error("Batch insert error:", error);
            }
            batch = [];
            pipeline.resume();
          }
        },
      );

      pipeline.on("end", async () => {
        // Flush remaining batch
        if (batch.length > 0) {
          try {
            const stored = await MessageRepository.createBatch(batch);
            status.total_stored += stored;
          } catch (error) {
            console.error("Final batch insert error:", error);
          }
        }
        resolve();
      });

      pipeline.on("error", (error: Error) => {
        reject(error);
      });
    });
  },

  /**
   * Extract plain text from Telegram's text field.
   * Text can be a string or array of text entities.
   */
  extractText(message: TelegramExportMessage): string {
    if (typeof message.text === "string") {
      return message.text.trim();
    }

    if (Array.isArray(message.text)) {
      return message.text
        .map((entity) => (typeof entity === "string" ? entity : entity.text))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    }

    return "";
  },

  /**
   * Get the status of an import job.
   */
  getStatus(jobId: string): ImportStatus | null {
    return importJobs.get(jobId) || null;
  },
};
