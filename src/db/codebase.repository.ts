import { getSupabaseClient } from "./client";
import { CreateCodeChunkInput, StoredCodeChunk } from "../lib/types";

/**
 * Database operations for code chunks.
 * Mirrors MessageRepository but targets the code_chunks table.
 */
export const CodebaseRepository = {
  /**
   * Batch insert code chunks (UPSERT, skip duplicates).
   * Used during codebase import — much faster than individual inserts.
   */
  async createBatch(inputs: CreateCodeChunkInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const supabase = getSupabaseClient();

    const rows = inputs.map((input) => ({
      workspace_id: input.workspace_id,
      source_chunk_id: input.source_chunk_id,
      file_path: input.file_path,
      repo_name: input.repo_name,
      language: input.language,
      chunk_index: input.chunk_index,
      content: input.content,
    }));

    const { data, error } = await supabase
      .from("code_chunks")
      .upsert(rows, {
        onConflict: "workspace_id,source_chunk_id",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      throw new Error(`Code chunk batch insert failed: ${error.message}`);
    }

    return data?.length || 0;
  },

  /**
   * Get code chunks that don't have embeddings yet.
   * Used by the background embedding worker.
   */
  async getUnembedded(limit: number = 50): Promise<StoredCodeChunk[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("code_chunks")
      .select()
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(
        `Failed to fetch unembedded code chunks: ${error.message}`,
      );
    }

    return (data || []) as StoredCodeChunk[];
  },

  /**
   * Update the embedding vector for a code chunk.
   */
  async updateEmbedding(
    chunkId: string,
    embedding: number[],
  ): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("code_chunks")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", chunkId);

    if (error) {
      throw new Error(
        `Failed to update code chunk embedding: ${error.message}`,
      );
    }
  },

  /**
   * Semantic search using pgvector cosine similarity.
   * Calls the search_code_chunks Postgres function.
   */
  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
  ): Promise<{ chunk: StoredCodeChunk; similarity: number }[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_code_chunks", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
    });

    if (error) {
      throw new Error(`Code chunk search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      chunk: {
        id: row.id,
        workspace_id: row.workspace_id,
        source_chunk_id: row.source_chunk_id,
        file_path: row.file_path,
        repo_name: row.repo_name,
        language: row.language,
        chunk_index: row.chunk_index,
        content: row.content,
        embedding: null,
        created_at: new Date(row.created_at),
      } as StoredCodeChunk,
      similarity: row.similarity,
    }));
  },

  /**
   * Full-text keyword search using PostgreSQL tsvector.
   * Calls the search_code_chunks_fulltext Postgres function.
   */
  async searchFullText(
    query: string,
    workspaceId: string,
    limit: number = 20,
  ): Promise<{ chunk: StoredCodeChunk; similarity: number }[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_code_chunks_fulltext", {
      search_query: query,
      match_workspace_id: workspaceId,
      match_count: limit,
    });

    if (error) {
      throw new Error(`Code chunk full-text search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      chunk: {
        id: row.id,
        workspace_id: row.workspace_id,
        source_chunk_id: row.source_chunk_id,
        file_path: row.file_path,
        repo_name: row.repo_name,
        language: row.language,
        chunk_index: row.chunk_index,
        content: row.content,
        embedding: null,
        created_at: new Date(row.created_at),
      } as StoredCodeChunk,
      similarity: row.rank,
    }));
  },

  /**
   * Get total code chunk count for a workspace.
   */
  async count(workspaceId: string): Promise<number> {
    const supabase = getSupabaseClient();

    const { count, error } = await supabase
      .from("code_chunks")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);

    if (error) return 0;
    return count || 0;
  },
};
