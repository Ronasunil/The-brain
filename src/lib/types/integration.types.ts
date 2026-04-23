export const INTEGRATION_TYPES = [
  "telegram",
  "slack",
  "github",
  "linear",
  "manual",
  "legacy-telegram",
] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_STATUSES = [
  "pending",
  "active",
  "paused",
  "disconnected",
  "error",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export type IntegrationConfig = Record<string, unknown>;

export interface TelegramIntegrationConfig extends IntegrationConfig {
  bot_token_ciphertext: string;
  bot_token_iv: string;
  bot_token_tag: string;
  bot_username: string;
}

export interface LinearIntegrationConfig extends IntegrationConfig {
  // OAuth-encrypted tokens
  access_token_ciphertext: string;
  access_token_iv: string;
  access_token_tag: string;
  refresh_token_ciphertext?: string;
  refresh_token_iv?: string;
  refresh_token_tag?: string;
  token_expires_at?: string;

  // Linear workspace identity
  linear_org_id: string;
  linear_org_name: string;
  linear_webhook_id?: string;

  // Backfill bookkeeping
  backfill_cursor?: string | null;
  backfill_complete?: boolean;
  backfill_total?: number;
  last_webhook_at?: string;
}

export interface Integration {
  id: string;
  workspace_id: string;
  type: IntegrationType;
  display_name: string;
  config: IntegrationConfig;
  webhook_secret: string;
  status: IntegrationStatus;
  last_error: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateIntegrationInput {
  workspace_id: string;
  type: IntegrationType;
  display_name: string;
  config?: IntegrationConfig;
  webhook_secret: string;
  status?: IntegrationStatus;
  created_by?: string | null;
}

export interface IntegrationResponse {
  id: string;
  workspace_id: string;
  type: IntegrationType;
  display_name: string;
  bot_username: string | null;
  repo_url: string | null;
  branch: string | null;
  last_synced_at: string | null;
  chunk_count: number | null;
  last_commit_message: string | null;
  last_commit_sha: string | null;
  status: IntegrationStatus;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}
