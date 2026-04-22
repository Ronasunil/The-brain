import crypto from "node:crypto";
import { getSupabaseClient } from "./client";
import {
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  Workspace,
} from "../lib/types/workspace.types";

function mapRow(row: any): Workspace {
  return {
    id: row.id,
    name: row.name,
    user_id: row.user_id,
    created_at: new Date(row.created_at),
  };
}

export const WorkspaceRepository = {
  /**
   * Create a workspace and seed its synthetic `manual` integration in the same call.
   * The manual integration backs the /brain/remember endpoint so every message has a
   * non-null integration_id.
   */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const supabase = getSupabaseClient();

    const { data: workspace, error } = await supabase
      .from("workspaces")
      .insert({ name: input.name, user_id: input.user_id })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create workspace: ${error.message}`);
    }

    const manualSecret = crypto.randomBytes(32).toString("hex");
    const { error: manualError } = await supabase.from("integrations").insert({
      workspace_id: workspace.id,
      type: "manual",
      display_name: "Manual Notes",
      webhook_secret: manualSecret,
      status: "active",
      created_by: input.user_id,
    });

    if (manualError) {
      throw new Error(
        `Failed to seed manual integration for workspace: ${manualError.message}`,
      );
    }

    return mapRow(workspace);
  },

  async findById(id: string): Promise<Workspace | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("workspaces")
      .select()
      .eq("id", id)
      .single();

    if (error) return null;
    return mapRow(data);
  },

  async findByOwner(userId: string): Promise<Workspace[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("workspaces")
      .select()
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      throw new Error(`Failed to list workspaces: ${error.message}`);
    }

    return (data ?? []).map(mapRow);
  },

  async update(id: string, data: UpdateWorkspaceInput): Promise<Workspace> {
    const supabase = getSupabaseClient();

    const { data: updated, error } = await supabase
      .from("workspaces")
      .update(data)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update workspace: ${error.message}`);
    }

    return mapRow(updated);
  },

  async delete(id: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from("workspaces").delete().eq("id", id);
    if (error) {
      throw new Error(`Failed to delete workspace: ${error.message}`);
    }
  },
};
