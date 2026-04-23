import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { IntegrationService } from "../services/integration.service";
import { GitHubService } from "../services/github.service";
import { CodeChunkRepository } from "../db/code-chunk.repository";
import { IntegrationRepository } from "../db/integration.repository";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import { GitHubIntegrationConfig } from "../lib/types/code-chunk.types";

export const GitHubController = {
  sync: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integrationId = req.params.integrationId as string;

    const integration = await IntegrationService.getById(
      integrationId,
      user.id,
    );

    if (integration.type !== "github") {
      throw new AppError("Integration is not a GitHub repo", 400);
    }

    if (integration.status === "disconnected") {
      throw new AppError("Integration is disconnected", 410);
    }

    await IntegrationRepository.updateStatus(integration.id, "pending", null);

    setImmediate(async () => {
      try {
        await GitHubService.syncRepository(integration);
        await IntegrationRepository.updateStatus(integration.id, "active", null);
      } catch (err: any) {
        console.error(`GitHub sync failed for ${integration.id}:`, err);
        await IntegrationRepository.updateStatus(
          integration.id,
          "error",
          `Sync failed: ${err?.message ?? "unknown error"}`,
        );
      }
    });

    res.status(200).json({
      status: 200,
      message: "Sync started",
    });
  }),

  status: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integrationId = req.params.integrationId as string;

    const integration = await IntegrationService.getById(
      integrationId,
      user.id,
    );

    if (integration.type !== "github") {
      throw new AppError("Integration is not a GitHub repo", 400);
    }

    const chunkCount = await CodeChunkRepository.countByIntegration(
      integration.id,
    );
    const config = integration.config as unknown as GitHubIntegrationConfig;

    res.status(200).json({
      status: 200,
      data: {
        integration_id: integration.id,
        repo_url: config.repo_url,
        branch: config.branch,
        status: integration.status,
        chunk_count: chunkCount,
        last_synced_at: config.last_synced_at ?? null,
        last_error: integration.last_error,
      },
    });
  }),
};
