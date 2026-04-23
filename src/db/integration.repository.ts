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

  /**
   * Merge `patch` into `integrations.config` at the SQL level (jsonb ||)
   * instead of read-modify-write in Node. Two concurrent callers merging
   * different keys won't clobber each other's writes.
   */
  async mergeConfig(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Integration | null> {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.rpc("merge_integration_config", {
      integration_id_in: id,
      patch_in: patch,
    });
    if (error) {
      throw new Error(`Failed to merge integration config: ${error.message}`);
    }
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return mapRow(row);
  },

  async softDelete(id: string): Promise<void> {
    await this.updateStatus(id, "disconnected");
  },

  /**
   * Linear integrations whose backfill never finished (e.g. crashed process).
   * Server startup calls this to restart them from their saved cursor.
   */
  async findIncompleteLinearBackfills(): Promise<Integration[]> {
    const supabase = getSupabaseClient();
    // Using `not` on JSONB key requires fetching and filtering in Node
    // because Supabase JS doesn't expose JSONB boolean coercion nicely.
    const { data, error } = await supabase
      .from("integrations")
      .select()
      .eq("type", "linear")
      .eq("status", "active");
    if (error) {
      throw new Error(`Failed to enumerate integrations: ${error.message}`);
    }
    return (data ?? [])
      .map(mapRow)
      .filter((row) => {
        const cfg = row.config as Record<string, unknown>;
        return cfg.backfill_complete !== true;
      });
  },

  async hardDelete(id: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from("integrations")
      .delete()
      .eq("id", id);

    if (error) {
      throw new Error(`Failed to delete integration: ${error.message}`);
    }
  },
};
