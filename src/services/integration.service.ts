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

    return IntegrationRepository.updateStatus(id, "disconnected", null);
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

  async getManualIntegration(workspaceId: string): Promise<Integration> {
    const manual = await IntegrationRepository.findManualForWorkspace(
      workspaceId,
    );
    if (!manual) {
      throw new AppError(
        "Workspace is missing its manual integration — corrupt state",
        500,
      );
    }
    return manual;
  },
};
