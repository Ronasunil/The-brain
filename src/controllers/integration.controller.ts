import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { IntegrationService } from "../services/integration.service";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import { CreateTelegramIntegrationPayload } from "../lib/validations/integration.schema";

export const IntegrationController = {
  create: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const { display_name, bot_token } = (req as any)
      .validatedBody as CreateTelegramIntegrationPayload;
    const workspaceId = req.params.workspaceId as string;

    const integration = await IntegrationService.createTelegram({
      workspaceId,
      userId: user.id,
      botToken: bot_token,
      displayName: display_name,
    });

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
};
