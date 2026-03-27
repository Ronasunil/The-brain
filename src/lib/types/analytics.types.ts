export interface CodeRepoAnalyticsRow {
  workspace_id: string;
  repo_name: string;
  chunk_count: number;
  file_count: number;
  content_bytes: number;
  embedded_chunks: number;
  pending_embedding: number;
  /** Content + vector + rough FTS/index overhead */
  estimated_storage_bytes: number;
  /** One-time embed cost to index this repo’s chunks (historical; uses content size) */
  estimated_indexing_cost_usd: number | null;
}

export interface CodeTotals {
  chunk_count: number;
  content_bytes: number;
  embedded_chunks: number;
  pending_embedding: number;
  distinct_files: number;
  estimated_storage_bytes: number;
  estimated_indexing_cost_usd: number | null;
}

export interface MessagesTotals {
  message_count: number;
  embedded_messages: number;
  pending_embedding: number;
  content_bytes: number;
  estimated_storage_bytes: number;
  estimated_indexing_cost_usd: number | null;
}

export interface AdminAnalyticsPayload {
  generated_at: string;
  ai_provider: string;
  cost_disclaimer: string;
  code_totals: CodeTotals;
  code_repos: CodeRepoAnalyticsRow[];
  messages_totals: MessagesTotals;
  source: "rpc" | "fallback";
}
