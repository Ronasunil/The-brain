/**
 * Stored code chunk record (from DB).
 */
export interface StoredCodeChunk {
  id: string;
  workspace_id: string;
  source_chunk_id: string;
  file_path: string;
  repo_name: string;
  language: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  created_at: Date;
}

/**
 * Input for creating a new code chunk (before DB insert).
 */
export interface CreateCodeChunkInput {
  workspace_id: string;
  source_chunk_id: string;
  file_path: string;
  repo_name: string;
  language: string;
  chunk_index: number;
  content: string;
}
