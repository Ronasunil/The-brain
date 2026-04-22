import { getSupabaseClient } from "./client";
import {
  Integration,
  IntegrationConfig,
  IntegrationStatus,
  IntegrationType,
  CreateIntegrationInput,
} from "../lib/types/integration.types";

function mapRow(row: any): Integration {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    type: row.type,
    display_name: row.display_name,
    config: (row.config ?? {}) as IntegrationConfig,
    webhook_secret: row.webhook_secret,
    status: row.status,
    last_error: row.last_error,
    created_by: row.created_by,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export const IntegrationRepository = {
  async create(input: CreateIntegrationInput): Promise<Integration> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .insert({
        workspace_id: input.workspace_id,
        type: input.type,
        display_name: input.display_name,
        config: input.config ?? {},
        webhook_secret: input.webhook_secret,
        status: input.status ?? "pending",
        created_by: input.created_by ?? null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create integration: ${error.message}`);
    }

    return mapRow(data);
  },

  async findById(id: string): Promise<Integration | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .select()
      .eq("id", id)
      .single();

    if (error) return null;
    return mapRow(data);
  },

  async findByWorkspace(
    workspaceId: string,
    type?: IntegrationType,
  ): Promise<Integration[]> {
    const supabase = getSupabaseClient();

    let query = supabase
      .from("integrations")
      .select()
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false });

    if (type) {
      query = query.eq("type", type);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list integrations: ${error.message}`);
    }

    return (data ?? []).map(mapRow);
  },

  async findManualForWorkspace(workspaceId: string): Promise<Integration | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("type", "manual")
      .limit(1)
      .maybeSingle();

    if (error) return null;
    return data ? mapRow(data) : null;
  },

  async updateStatus(
    id: string,
    status: IntegrationStatus,
    lastError: string | null = null,
  ): Promise<Integration> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .update({ status, last_error: lastError })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update integration status: ${error.message}`);
    }

    return mapRow(data);
  },

  async updateConfig(id: string, config: IntegrationConfig): Promise<Integration> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("integrations")
      .update({ config })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update integration config: ${error.message}`);
    }

    return mapRow(data);
  },

  async softDelete(id: string): Promise<void> {
    await this.updateStatus(id, "disconnected");
  },
};
