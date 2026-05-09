/**
 * Message source platforms.
 */
export const MESSAGE_SOURCES = [
  "telegram",
  "slack",
  "github",
  "linear",
  "manual",
  "web",
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
 * Inbuilt chat message (group chat thread).
 */
export interface ChatMessage {
  id: string;
  workspace_id: string;
  user_id: string | null;
  user_name: string | null;
  role: "user" | "assistant";
  content: string;
  sources: BrainAnswerSource[] | null;
  card: ChatCardPayload | null;
  created_at: Date;
}

export interface CreateChatMessageInput {
  workspace_id: string;
  user_id?: string | null;
  user_name?: string | null;
  role: "user" | "assistant";
  content: string;
  sources?: BrainAnswerSource[] | null;
  card?: ChatCardPayload | null;
}

/**
 * A structured payload the frontend renders as a rich card next to (or in
 * place of) the markdown `content`. Discriminated by `type` so we can grow
 * new card kinds without breaking older clients.
 */
export type ChatCardPayload = LinearTicketCard;

export interface LinearTicketCard {
  type: "linear_ticket";
  integrationId: string;
  issue: LinearTicketCardIssue;
  // Dropdown choices (assignable users, workflow states, etc.) live behind a
  // dedicated endpoint instead of being baked into the card payload — they
  // can be 5-10KB per workspace and would bloat every chat_messages row if
  // persisted. Frontend fetches via GET /integrations/linear/:id/teams/:teamId/options
  // on card mount, with a small client-side cache to avoid refetching across
  // sibling cards in the same conversation.
}

export interface LinearTicketCardIssue {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  priority: 0 | 1 | 2 | 3 | 4;
  priorityLabel: string;
  status: { id: string; name: string; type: string } | null;
  assignee: { id: string; name: string; email: string | null } | null;
  team: { id: string; key: string; name: string };
  createdAt: string;
}

// (LinearTicketCardOptions is no longer part of the card payload — the
// frontend fetches it on demand. The shape returned by the options endpoint
// is documented in LinearService.getTeamOptions.)

/**
 * AI-generated answer with sources.
 */
export interface BrainAnswerSource {
  content: string;
  user_name: string;
  source: MessageSource | "github" | "operational_memory" | "operational_context";
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
