import { z } from "zod";

/**
 * Telegram Desktop export JSON format.
 * We only validate the outer shape — messages are parsed as a stream.
 */
export const telegramImportSchema = z.object({
  workspace_id: z.string().optional(),
  chat_id: z.string().min(1, "chat_id is required"),
  chat_name: z.string().min(1, "chat_name is required"),
});

export type TelegramImportPayload = z.infer<typeof telegramImportSchema>;

/**
 * Shape of a single message inside Telegram Desktop export JSON.
 */
export interface TelegramExportMessage {
  id: number;
  type: string;
  date: string;
  date_unixtime: string;
  from: string;
  from_id: string;
  text: string | Array<{ type: string; text: string }>;
  text_entities?: Array<{ type: string; text: string }>;
}

/**
 * Import job status tracker.
 */
export interface ImportStatus {
  status: "processing" | "completed" | "failed";
  total_parsed: number;
  total_stored: number;
  total_skipped: number;
  total_embedded: number;
  started_at: Date;
  completed_at: Date | null;
  error: string | null;
}
