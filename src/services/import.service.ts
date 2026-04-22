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
import {
  IMPORT_BATCH_SIZE,
  MIN_MESSAGE_LENGTH,
} from "../lib/constants/import.constants";

const importJobs = new Map<string, ImportStatus>();

interface ImportParams {
  filePath: string;
  chatId: string;
  chatName: string;
  workspaceId: string;
  integrationId: string;
}

/**
 * Import Service — bulk-imports messages from platform exports.
 * Every batch row carries workspace_id + integration_id so the data is
 * correctly scoped to the caller's workspace/integration.
 */
export const ImportService = {
  async importTelegramExport(params: ImportParams): Promise<string> {
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

    this.processFile(params, status)
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

  async processFile(params: ImportParams, status: ImportStatus): Promise<void> {
    const { filePath, chatId, chatName, workspaceId, integrationId } = params;

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
          if (value.type !== "message") return;

          const text = this.extractText(value);
          if (!text || text.length < MIN_MESSAGE_LENGTH) {
            status.total_skipped++;
            return;
          }

          status.total_parsed++;

          const input: CreateMessageInput = {
            workspace_id: workspaceId,
            integration_id: integrationId,
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

  getStatus(jobId: string): ImportStatus | null {
    return importJobs.get(jobId) || null;
  },
};
