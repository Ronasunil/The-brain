import { getSupabaseClient } from "./client";
import { ChatMessage, CreateChatMessageInput } from "../lib/types";

const TABLE = "inbuilt_chat_messages";

export const ChatMessageRepository = {
  async create(input: CreateChatMessageInput): Promise<ChatMessage> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from(TABLE)
      .insert({
        workspace_id: input.workspace_id,
        user_id: input.user_id ?? null,
        user_name: input.user_name ?? null,
        role: input.role,
        content: input.content,
        sources: input.sources ?? null,
      })
      .select("*")
      .single();

    if (error) throw new Error(`Failed to create chat message: ${error.message}`);
    return mapRow(data);
  },

  async listByWorkspace(
    workspaceId: string,
    opts: { limit?: number; before?: string } = {},
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const supabase = getSupabaseClient();
    const limit = opts.limit ?? 50;

    let query = supabase
      .from(TABLE)
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(limit + 1);

    if (opts.before) {
      query = query.lt("created_at", opts.before);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to list chat messages: ${error.message}`);

    const rows = data ?? [];
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(mapRow);

    // Return in chronological order (oldest first) for display
    messages.reverse();

    return { messages, hasMore };
  },
};

function mapRow(row: any): ChatMessage {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    user_name: row.user_name,
    role: row.role,
    content: row.content,
    sources: row.sources,
    created_at: new Date(row.created_at),
  };
}
