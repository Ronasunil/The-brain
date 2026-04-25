import { getSupabaseClient } from "./client";

const TABLE = "user_linear_preferences";

export interface UserLinearPreference {
  workspace_id: string;
  user_id: string;
  integration_id: string;
  last_team_id: string;
  updated_at: Date;
}

function mapRow(row: any): UserLinearPreference {
  return {
    workspace_id: row.workspace_id,
    user_id: row.user_id,
    integration_id: row.integration_id,
    last_team_id: row.last_team_id,
    updated_at: new Date(row.updated_at),
  };
}

export const UserLinearPreferencesRepository = {
  async get(
    workspaceId: string,
    userId: string,
    integrationId: string,
  ): Promise<UserLinearPreference | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from(TABLE)
      .select()
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Failed to read user_linear_preferences: ${error.message}`,
      );
    }
    return data ? mapRow(data) : null;
  },

  async upsertLastTeam(params: {
    workspace_id: string;
    user_id: string;
    integration_id: string;
    last_team_id: string;
  }): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from(TABLE).upsert(
      {
        workspace_id: params.workspace_id,
        user_id: params.user_id,
        integration_id: params.integration_id,
        last_team_id: params.last_team_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,user_id,integration_id" },
    );

    if (error) {
      throw new Error(
        `Failed to upsert user_linear_preferences: ${error.message}`,
      );
    }
  },
};
