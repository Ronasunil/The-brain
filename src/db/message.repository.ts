import { getSupabaseClient } from "./client";
import { CreateMessageInput, StoredMessage, SearchResult } from "../lib/types";

function mapSearchRow(row: any): SearchResult["message"] {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    integration_id: row.integration_id,
    source: row.source,
    source_message_id: row.source_message_id,
    user_name: row.user_name,
    user_id: row.user_id,
    chat_id: row.chat_id,
    chat_name: row.chat_name,
    content: row.content,
    timestamp: new Date(row.timestamp),
    embedding: null,
    created_at: new Date(row.created_at),
  };
}

export const MessageRepository = {
  async create(input: CreateMessageInput): Promise<StoredMessage> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .insert({
        workspace_id: input.workspace_id,
        integration_id: input.integration_id,
        source: input.source,
        source_message_id: input.source_message_id,
        user_name: input.user_name,
        user_id: input.user_id,
        chat_id: input.chat_id,
        chat_name: input.chat_name,
        content: input.content,
        timestamp: input.timestamp.toISOString(),
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        const existing = await this.findByDedupKey(
          input.integration_id,
          input.chat_id,
          input.source_message_id,
        );
        if (existing) return existing;
      }
      throw new Error(`Failed to insert message: ${error.message}`);
    }

    return data as StoredMessage;
  },

  async findByDedupKey(
    integrationId: string,
    chatId: string,
    sourceMessageId: string,
  ): Promise<StoredMessage | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .select()
      .eq("integration_id", integrationId)
      .eq("chat_id", chatId)
      .eq("source_message_id", sourceMessageId)
      .maybeSingle();

    if (error) return null;
    return (data as StoredMessage) ?? null;
  },

  async updateEmbedding(messageId: string, embedding: number[]): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("messages")
      .update({ embedding: JSON.stringify(embedding) })
      .eq("id", messageId);

    if (error) {
      throw new Error(`Failed to update embedding: ${error.message}`);
    }
  },

  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
    integrationId?: string,
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_messages", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
      match_integration_id: integrationId ?? null,
    });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      message: mapSearchRow(row),
      similarity: row.similarity,
    }));
  },

  async createBatch(inputs: CreateMessageInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const supabase = getSupabaseClient();

    const rows = inputs.map((input) => ({
      workspace_id: input.workspace_id,
      integration_id: input.integration_id,
      source: input.source,
      source_message_id: input.source_message_id,
      user_name: input.user_name,
      user_id: input.user_id,
      chat_id: input.chat_id,
      chat_name: input.chat_name,
      content: input.content,
      timestamp: input.timestamp.toISOString(),
    }));

    const { data, error } = await supabase
      .from("messages")
      .upsert(rows, {
        onConflict: "integration_id,chat_id,source_message_id",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      throw new Error(`Batch insert failed: ${error.message}`);
    }

    return data?.length || 0;
  },

  async getUnembedded(limit: number = 50): Promise<StoredMessage[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .select()
      .is("embedding", null)
      .order("timestamp", { ascending: true })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch unembedded messages: ${error.message}`);
    }

    return (data || []) as StoredMessage[];
  },

  async count(workspaceId: string): Promise<number> {
    const supabase = getSupabaseClient();

    const { count, error } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);

    if (error) return 0;
    return count || 0;
  },

  async searchManual(
    workspaceId: string,
    queryEmbedding: number[],
    limit: number,
    threshold: number,
    integrationId?: string,
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_messages_manual", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
      match_integration_id: integrationId ?? null,
    });

    if (error) {
      throw new Error(`Manual search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      message: mapSearchRow(row),
      similarity: row.similarity,
    }));
  },

  async searchFullText(
    query: string,
    workspaceId: string,
    limit: number = 20,
    integrationId?: string,
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_messages_fulltext", {
      search_query: query,
      match_workspace_id: workspaceId,
      match_count: limit,
      match_integration_id: integrationId ?? null,
    });

    if (error) {
      throw new Error(`Full-text search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      message: mapSearchRow(row),
      similarity: row.rank,
    }));
  },
};
