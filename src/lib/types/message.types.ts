/**
 * Message source platforms.
 */
export const MESSAGE_SOURCES = [
  "telegram",
  "slack",
  "github",
  "linear",
  "manual",
] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/**
 * Stored message record (from DB).
 */
export interface StoredMessage {
  id: string;
  workspace_id: string;
  integration_id: string;
  source: MessageSource;
  source_message_id: string;
  user_name: string;
  user_id: string;
  chat_id: string;
  chat_name: string;
  content: string;
  timestamp: Date;
  embedding: number[] | null;
  created_at: Date;
}

/**
 * Input for creating a new message (before DB insert).
 */
export interface CreateMessageInput {
  workspace_id: string;
  integration_id: string;
  source: MessageSource;
  source_message_id: string;
  user_name: string;
  user_id: string;
  chat_id: string;
  chat_name: string;
  content: string;
  timestamp: Date;
}

/**
 * Curated response shape for POST /brain/remember.
 */
export interface RememberedItem {
  id: string;
  content: string;
  timestamp: Date;
  created_at: Date;
}

/**
 * Search result with similarity score.
 */
export interface SearchResult {
  message: StoredMessage;
  similarity: number;
}

/**
 * AI-generated answer with sources.
 */
export interface BrainAnswerSource {
  content: string;
  user_name: string;
  source: MessageSource | "github";
  timestamp: Date;
  similarity: number;
  file_path?: string;
  line_start?: number;
  line_end?: number;
}

export interface BrainAnswer {
  answer: string;
  sources: BrainAnswerSource[];
}
