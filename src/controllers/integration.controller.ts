import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { IntegrationService } from "../services/integration.service";
import { GitHubService } from "../services/github.service";
import { IntegrationRepository } from "../db/integration.repository";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import { Integration } from "../lib/types/integration.types";
import {
  CreateIntegrationPayload,
} from "../lib/validations/integration.schema";

export const IntegrationController = {
  create: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const body = (req as any).validatedBody as CreateIntegrationPayload;
    const workspaceId = req.params.workspaceId as string;

    let integration: Integration;

    if (body.type === "telegram") {
      integration = await IntegrationService.createTelegram({
        workspaceId,
        userId: user.id,
        botToken: body.bot_token,
        displayName: body.display_name,
      });
    } else if (body.type === "github") {
      await GitHubService.validateRepoUrl(body.repo_url, body.access_token);

      integration = await IntegrationService.createGitHub({
        workspaceId,
        userId: user.id,
        repoUrl: body.repo_url,
        accessToken: body.access_token,
        branch: body.branch,
        displayName: body.display_name,
      });

      const integrationId = integration.id;
      setImmediate(async () => {
        try {
          await GitHubService.cloneAndIndex(integration);
          await IntegrationRepository.updateStatus(integrationId, "active", null);
        } catch (err: any) {
          console.error(`GitHub indexing failed for ${integrationId}:`, err);
          await IntegrationRepository.updateStatus(
            integrationId,
            "error",
            `Indexing failed: ${err?.message ?? "unknown error"}`,
          );
        }
      });
    } else {
      res.status(400).json({ status: 400, message: "Unsupported integration type" });
      return;
    }

    res.status(201).json({
      status: 201,
      data: IntegrationService.toResponse(integration),
      message: "Integration created successfully",
    });
  }),

  list: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const workspaceId = req.params.workspaceId as string;

    const integrations = await IntegrationService.listForWorkspace(
      workspaceId,
      user.id,
    );

    res.status(200).json({
      status: 200,
      data: integrations.map(IntegrationService.toResponse),
      message: "Integrations fetched successfully",
    });
  }),

  getById: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integration = await IntegrationService.getById(
      req.params.id as string,
      user.id,
    );

    res.status(200).json({
      status: 200,
      data: IntegrationService.toResponse(integration),
      message: "Integration fetched successfully",
    });
  }),

  disconnect: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const integration = await IntegrationService.disconnect(
      req.params.id as string,
      user.id,
    );

    res.status(200).json({
      status: 200,
      data: IntegrationService.toResponse(integration),
      message: "Integration disconnected successfully",
    });
  }),

  remove: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    await IntegrationService.remove(req.params.id as string, user.id);

    res.status(200).json({
      status: 200,
      message: "Integration permanently removed",
    });
  }),
};
