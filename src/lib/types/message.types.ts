import { StoredCodeChunk } from "./code.types";

/**
 * Message source platforms.
 */
export const MESSAGE_SOURCES = [
  "telegram",
  "slack",
  "github",
  "linear",
  "manual",
  "code",
] as const;
export type MessageSource = (typeof MESSAGE_SOURCES)[number];

/**
 * Stored message record (from DB).
 */
export interface StoredMessage {
  id: string;
  workspace_id: string;
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
 * Search result with similarity score.
 */
export interface SearchResult {
  message: StoredMessage;
  similarity: number;
}

/**
 * A unified search result item — either a message or a code chunk.
 */
export type SearchResultItem =
  | { kind: "message"; data: StoredMessage }
  | { kind: "code"; data: StoredCodeChunk };

/**
 * Unified search result wrapping both messages and code chunks.
 */
export interface UnifiedSearchResult {
  item: SearchResultItem;
  similarity: number;
}

/**
 * AI-generated answer with sources.
 */
export interface BrainAnswer {
  answer: string;
  sources: Array<{
    content: string;
    user_name: string;
    source: string;
    timestamp: Date;
    similarity: number;
    file_path?: string;
  }>;
}
