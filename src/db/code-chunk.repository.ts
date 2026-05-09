import { getSupabaseClient } from "./client";
import {
  CodeChunk,
  CreateCodeChunkInput,
  CodeSearchResult,
} from "../lib/types";

function mapRow(row: any): CodeChunk {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    file_path: row.file_path,
    repo_name: row.repo_name,
    language: row.language,
    chunk_type: row.chunk_type,
    line_start: row.line_start,
    line_end: row.line_end,
    content: row.content,
    embedding: null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export const CodeChunkRepository = {
  async createBatch(inputs: CreateCodeChunkInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const supabase = getSupabaseClient();

    const rows = inputs.map((input) => ({
      workspace_id: input.workspace_id,
      integration_id: input.integration_id,
      file_path: input.file_path,
      repo_name: input.repo_name,
      language: input.language ?? null,
      chunk_type: input.chunk_type ?? "file",
      line_start: input.line_start ?? null,
      line_end: input.line_end ?? null,
      content: input.content,
    }));

    const { data, error } = await supabase
      .from("code_chunks")
      .upsert(rows, {
        onConflict: "integration_id,file_path,line_start",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      throw new Error(`Code chunk batch insert failed: ${error.message}`);
    }

    return data?.length || 0;
  },

  async updateEmbedding(id: string, embedding: number[]): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("code_chunks")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to update code chunk embedding: ${error.message}`);
    }
  },

  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
    integrationId?: string,
  ): Promise<CodeSearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_code_chunks", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
      match_integration_id: integrationId ?? null,
    });

    if (error) {
      throw new Error(`Code chunk search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      chunk: {
        id: row.id,
        workspace_id: row.workspace_id,
        integration_id: row.integration_id,
        file_path: row.file_path,
        repo_name: row.repo_name,
        language: row.language,
        chunk_type: row.chunk_type,
        line_start: row.line_start,
        line_end: row.line_end,
        content: row.content,
        embedding: null,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.created_at),
      } as CodeChunk,
      similarity: row.similarity as number,
    }));
  },

  async searchFullText(
    query: string,
    workspaceId: string,
    limit: number = 20,
    integrationId?: string,
  ): Promise<CodeSearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_code_chunks_fulltext", {
      search_query: query,
      match_workspace_id: workspaceId,
      match_count: limit,
      match_integration_id: integrationId ?? null,
    });

    if (error) {
      throw new Error(`Code chunk full-text search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      chunk: {
        id: row.id,
        workspace_id: row.workspace_id,
        integration_id: row.integration_id,
        file_path: row.file_path,
        repo_name: row.repo_name,
        language: row.language,
        chunk_type: row.chunk_type,
        line_start: row.line_start,
        line_end: row.line_end,
        content: row.content,
        embedding: null,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.created_at),
      } as CodeChunk,
      similarity: row.rank as number,
    }));
  },

  async listProjectOverview(
    workspaceId: string,
    limit: number = 8,
    integrationId?: string,
  ): Promise<CodeSearchResult[]> {
    const supabase = getSupabaseClient();
    let query = supabase
      .from("code_chunks")
      .select()
      .eq("workspace_id", workspaceId)
      .order("file_path", { ascending: true })
      .limit(1000);

    if (integrationId) query = query.eq("integration_id", integrationId);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Code chunk overview fetch failed: ${error.message}`);
    }

    const scored = (data || [])
      .map((row: any) => {
        const path = String(row.file_path ?? "").toLowerCase();
        const content = String(row.content ?? "").toLowerCase();
        let score = 0.28;
        if (/(^|\/)readme(\.[a-z0-9]+)?$/.test(path)) score += 0.7;
        if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(path)) {
          score += 0.58;
        }
        if (/(^|\/)(vite\.config|next\.config|nuxt\.config|tsconfig\.json|dockerfile|compose\.ya?ml)$/.test(path)) {
          score += 0.34;
        }
        if (path.startsWith("docs/") || path.includes("/docs/")) score += 0.38;
        if (/(^|\/)(src|app|lib)\/(app|main|index|server|routes|api|page)\.[a-z0-9.]+$/.test(path)) {
          score += 0.28;
        }
        if (/\b(description|architecture|overview|getting started|features|scripts|dependencies|routes|api)\b/.test(content)) {
          score += 0.2;
        }
        if (/(^|\/)(demo|example|examples|test|tests|spec|stories|dist|build)\//.test(path)) {
          score -= 0.22;
        }
        return { row, score: Math.min(0.98, score) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ row, score }) => ({
      chunk: mapRow(row),
      similarity: score,
      contextHint:
        "Project overview context. Use this to summarize the repository's purpose, stack, architecture, and main capabilities.",
    }));
  },

  async getUnembedded(limit: number = 50): Promise<CodeChunk[]> {
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

    return (data || []).map(mapRow);
  },

  async deleteByIntegration(integrationId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("code_chunks")
      .delete()
      .eq("integration_id", integrationId);

    if (error) {
      throw new Error(
        `Failed to delete code chunks for integration: ${error.message}`,
      );
    }
  },

  async deleteByFilePaths(
    integrationId: string,
    filePaths: string[],
  ): Promise<void> {
    if (filePaths.length === 0) return;

    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("code_chunks")
      .delete()
      .eq("integration_id", integrationId)
      .in("file_path", filePaths);

    if (error) {
      throw new Error(`Failed to delete code chunks by file path: ${error.message}`);
    }
  },

  async countByIntegration(integrationId: string): Promise<number> {
    const supabase = getSupabaseClient();

    const { count, error } = await supabase
      .from("code_chunks")
      .select("*", { count: "exact", head: true })
      .eq("integration_id", integrationId);

    if (error) return 0;
    return count || 0;
  },
};
