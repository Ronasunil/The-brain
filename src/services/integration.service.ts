import crypto from "node:crypto";
import TelegramBot from "node-telegram-bot-api";
import { env } from "../config/env";
import { AppError } from "../lib/errors/app-error";
import { IntegrationRepository } from "../db/integration.repository";
import { WorkspaceService } from "./workspace.service";
import { encrypt, decrypt } from "../lib/utils/encryption";
import {
  Integration,
  IntegrationResponse,
  TelegramIntegrationConfig,
} from "../lib/types/integration.types";
import { GitHubIntegrationConfig } from "../lib/types/code-chunk.types";

const WEBHOOK_PATH_PREFIX = "/api/v1/telegram/webhook";

function buildWebhookUrl(integrationId: string): string {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${WEBHOOK_PATH_PREFIX}/${integrationId}`;
}

export const IntegrationService = {
  toResponse(integration: Integration): IntegrationResponse {
    const botUsername =
      typeof integration.config.bot_username === "string"
        ? integration.config.bot_username
        : null;

    return {
      id: integration.id,
      workspace_id: integration.workspace_id,
      type: integration.type,
      display_name: integration.display_name,
      bot_username: botUsername,
      repo_url:
        typeof integration.config.repo_url === "string"
          ? integration.config.repo_url
          : null,
      branch:
        typeof integration.config.branch === "string"
          ? integration.config.branch
          : null,
      last_synced_at:
        typeof integration.config.last_synced_at === "string"
          ? integration.config.last_synced_at
          : null,
      chunk_count:
        typeof integration.config.chunk_count === "number"
          ? integration.config.chunk_count
          : null,
      last_commit_message:
        typeof integration.config.last_commit_message === "string"
          ? integration.config.last_commit_message
          : null,
      last_commit_sha:
        typeof integration.config.last_commit_sha === "string"
          ? integration.config.last_commit_sha
          : null,
      status: integration.status,
      last_error: integration.last_error,
      created_at: integration.created_at,
      updated_at: integration.updated_at,
    };
  },

  async listForWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<Integration[]> {
    await WorkspaceService.assertOwnership(userId, workspaceId);
    return IntegrationRepository.findByWorkspace(workspaceId);
  },

  async getById(id: string, userId: string): Promise<Integration> {
    const integration = await IntegrationRepository.findById(id);
    if (!integration) {
      throw new AppError("Integration not found", 404);
    }
    await WorkspaceService.assertOwnership(userId, integration.workspace_id);
    return integration;
  },

  async createTelegram(params: {
    workspaceId: string;
    userId: string;
    botToken: string;
    displayName: string;
  }): Promise<Integration> {
    await WorkspaceService.assertOwnership(params.userId, params.workspaceId);

    const bot = new TelegramBot(params.botToken);
    let botUsername: string;
    try {
      const me = await bot.getMe();
      if (!me.username) {
        throw new Error("Bot has no username");
      }
      botUsername = me.username;
    } catch (err: any) {
      throw new AppError(
        `Invalid bot token: ${err?.message ?? "unknown error"}`,
        400,
      );
    }

    const encrypted = encrypt(params.botToken);
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const config: TelegramIntegrationConfig = {
      bot_token_ciphertext: encrypted.ciphertext,
      bot_token_iv: encrypted.iv,
      bot_token_tag: encrypted.tag,
      bot_username: botUsername,
    };

    const integration = await IntegrationRepository.create({
      workspace_id: params.workspaceId,
      type: "telegram",
      display_name: params.displayName,
      config,
      webhook_secret: webhookSecret,
      status: "pending",
      created_by: params.userId,
    });

    const webhookUrl = buildWebhookUrl(integration.id);
    try {
      await bot.setWebHook(webhookUrl, { secret_token: webhookSecret });
      return IntegrationRepository.updateStatus(integration.id, "active", null);
    } catch (err: any) {
      return IntegrationRepository.updateStatus(
        integration.id,
        "error",
        `setWebHook failed: ${err?.message ?? "unknown error"}`,
      );
    }
  },

  async createGitHub(params: {
    workspaceId: string;
    userId: string;
    repoUrl: string;
    accessToken?: string;
    branch?: string;
    displayName: string;
  }): Promise<Integration> {
    await WorkspaceService.assertOwnership(params.userId, params.workspaceId);

    const branch = params.branch || "main";
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const config: GitHubIntegrationConfig = {
      repo_url: params.repoUrl,
      branch,
    };

    if (params.accessToken) {
      const encrypted = encrypt(params.accessToken);
      config.access_token_ciphertext = encrypted.ciphertext;
      config.access_token_iv = encrypted.iv;
      config.access_token_tag = encrypted.tag;
    }

    const integration = await IntegrationRepository.create({
      workspace_id: params.workspaceId,
      type: "github",
      display_name: params.displayName,
      config,
      webhook_secret: webhookSecret,
      status: "pending",
      created_by: params.userId,
    });

    return integration;
  },

  async disconnect(id: string, userId: string): Promise<Integration> {
    const integration = await this.getById(id, userId);

    if (integration.type === "telegram") {
      try {
        const token = this.getDecryptedToken(integration);
        const bot = new TelegramBot(token);
        await bot.deleteWebHook();
      } catch (err: any) {
        console.warn(
          `deleteWebHook failed for integration ${id}: ${err?.message}`,
        );
      }
    }

    if (integration.type === "linear") {
      // Lazy import to avoid circular dependency (LinearService uses
      // IntegrationRepository, not IntegrationService, but keep it clean).
      const { LinearService } = await import("./linear.service");
      await LinearService.disconnect(integration);
      const refreshed = await IntegrationRepository.findById(id);
      if (refreshed) return refreshed;
    }

    if (integration.type === "github") {
      const { GitHubService } = await import("./github.service");
      try {
        await GitHubService.removeRepository(id);
      } catch (err: any) {
        console.warn(
          `GitHub repo cleanup failed for integration ${id}: ${err?.message}`,
        );
      }
    }

    return IntegrationRepository.updateStatus(id, "disconnected", null);
  },

  async remove(id: string, userId: string): Promise<void> {
    const integration = await this.getById(id, userId);

    if (integration.status !== "disconnected") {
      throw new AppError(
        "Only disconnected integrations can be permanently removed",
        400,
      );
    }

    if (integration.type === "github") {
      const { GitHubService } = await import("./github.service");
      try {
        await GitHubService.removeRepository(id);
      } catch {
        // already cleaned up during disconnect
      }
    }

    await IntegrationRepository.hardDelete(id);
  },

  getDecryptedToken(integration: Integration): string {
    const cfg = integration.config as Partial<TelegramIntegrationConfig>;

    if (!cfg.bot_token_ciphertext || !cfg.bot_token_iv || !cfg.bot_token_tag) {
      throw new AppError(
        `Integration ${integration.id} has no encrypted token`,
        500,
      );
    }

    return decrypt({
      ciphertext: cfg.bot_token_ciphertext,
      iv: cfg.bot_token_iv,
      tag: cfg.bot_token_tag,
    });
  },

  getDecryptedGitHubToken(integration: Integration): string {
    const cfg = integration.config as Partial<GitHubIntegrationConfig>;

    if (
      !cfg.access_token_ciphertext ||
      !cfg.access_token_iv ||
      !cfg.access_token_tag
    ) {
      throw new AppError(
        `Integration ${integration.id} has no encrypted GitHub token`,
        500,
      );
    }

    return decrypt({
      ciphertext: cfg.access_token_ciphertext,
      iv: cfg.access_token_iv,
      tag: cfg.access_token_tag,
    });
  },

  async getManualIntegration(workspaceId: string): Promise<Integration> {
    const existing = await IntegrationRepository.findManualForWorkspace(
      workspaceId,
    );
    if (existing) {
      return existing;
    }

    // Backward compatibility: older workspaces may predate manual integration seeding.
    const workspace = await WorkspaceService.getById(workspaceId);
    const webhookSecret = crypto.randomBytes(32).toString("hex");

    await IntegrationRepository.create({
      workspace_id: workspaceId,
      type: "manual",
      display_name: "Manual Notes",
      webhook_secret: webhookSecret,
      status: "active",
      created_by: workspace.user_id ?? null,
    });

    const created = await IntegrationRepository.findManualForWorkspace(
      workspaceId,
    );

    if (!created) {
      throw new AppError(
        "Workspace is missing its manual integration after auto-repair",
        500,
      );
    }

    return created;
  },
};
