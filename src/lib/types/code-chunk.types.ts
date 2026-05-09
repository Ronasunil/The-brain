export interface CodeChunk {
  id: string;
  workspace_id: string;
  integration_id: string;
  file_path: string;
  repo_name: string;
  language: string | null;
  chunk_type: string;
  line_start: number | null;
  line_end: number | null;
  content: string;
  embedding: number[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCodeChunkInput {
  workspace_id: string;
  integration_id: string;
  file_path: string;
  repo_name: string;
  language?: string;
  chunk_type?: string;
  line_start?: number;
  line_end?: number;
  content: string;
}

export interface CodeSearchResult {
  chunk: CodeChunk;
  similarity: number;
  contextHint?: string;
}

export interface GitHubIntegrationConfig {
  [key: string]: unknown;
  repo_url: string;
  branch: string;
  access_token_ciphertext?: string;
  access_token_iv?: string;
  access_token_tag?: string;
  last_synced_at?: string;
  chunk_count?: number;
  last_commit_message?: string;
  last_commit_sha?: string;
}
