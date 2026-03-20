import { getSupabaseClient } from "./client";
import { CreateMessageInput, StoredMessage, SearchResult } from "../lib/types";

/**
 * Database operations for messages.
 * All raw SQL/Supabase calls live here — services call these methods.
 */
export const MessageRepository = {
  /**
   * Insert a new message into the database.
   */
  async create(input: CreateMessageInput): Promise<StoredMessage> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .insert({
        workspace_id: input.workspace_id,
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
      // Duplicate message — return existing
      if (error.code === "23505") {
        const existing = await this.findBySourceId(
          input.source,
          input.source_message_id,
        );
        if (existing) return existing;
      }
      throw new Error(`Failed to insert message: ${error.message}`);
    }

    return data as StoredMessage;
  },

  /**
   * Find a message by source platform + original message ID.
   */
  async findBySourceId(
    source: string,
    sourceMessageId: string,
  ): Promise<StoredMessage | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .select()
      .eq("source", source)
      .eq("source_message_id", sourceMessageId)
      .single();

    if (error) return null;
    return data as StoredMessage;
  },

  /**
   * Update the embedding vector for a message.
   */
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

  /**
   * Semantic search using pgvector cosine similarity.
   * Calls the search_messages Postgres function.
   */
  async searchSimilar(
    queryEmbedding: number[],
    workspaceId: string,
    limit: number = 5,
    threshold: number = 0.3,
  ): Promise<SearchResult[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("search_messages", {
      query_embedding: JSON.stringify(queryEmbedding),
      match_workspace_id: workspaceId,
      match_count: limit,
      similarity_threshold: threshold,
    });

    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      message: {
        id: row.id,
        workspace_id: row.workspace_id,
        source: row.source,
        source_message_id: row.source_message_id,
        user_name: row.user_name,
        user_id: row.user_id,
        chat_id: row.chat_id,
        chat_name: row.chat_name,
        content: row.content,
        timestamp: new Date(row.timestamp),
        embedding: null, // Not returned from search
        created_at: new Date(row.created_at),
      } as StoredMessage,
      similarity: row.similarity,
    }));
  },

  /**
   * Batch insert messages (skips duplicates).
   * Used for bulk imports — much faster than individual inserts.
   */
  async createBatch(inputs: CreateMessageInput[]): Promise<number> {
    if (inputs.length === 0) return 0;

    const supabase = getSupabaseClient();

    const rows = inputs.map((input) => ({
      workspace_id: input.workspace_id,
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
        onConflict: "source,source_message_id",
        ignoreDuplicates: true,
      })
      .select("id");

    if (error) {
      throw new Error(`Batch insert failed: ${error.message}`);
    }

    return data?.length || 0;
  },

  /**
   * Get messages that don't have embeddings yet.
   * Used by the background embedding worker.
   */
  async getUnembedded(limit: number = 50): Promise<StoredMessage[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("messages")
      .select()
      .is("embedding", null)
      .order("timestamp", { ascending: true })
      .limit(limit);

    if (error) {
      console.log(error)
      throw new Error(`Failed to fetch unembedded messages: ${error.message}`);
    }

    return (data || []) as StoredMessage[];
  },

  /**
   * Get total message count for a workspace.
   */
  async count(workspaceId: string): Promise<number> {
    const supabase = getSupabaseClient();

    const { count, error } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);

    if (error) return 0;
    return count || 0;
  },
};
