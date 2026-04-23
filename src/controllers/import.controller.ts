import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { ImportService } from "../services/import.service";
import { IntegrationService } from "../services/integration.service";
import { WorkspaceService } from "../services/workspace.service";
import { AuthenticatedRequest } from "../lib/types/auth.types";

export const ImportController = {
  importTelegram: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;
    const { integration_id, file_path, chat_id, chat_name } = req.body ?? {};

    if (!integration_id || !file_path || !chat_id || !chat_name) {
      throw new AppError(
        "integration_id, file_path, chat_id, and chat_name are required",
        400,
      );
    }

    const integration = await IntegrationService.getById(
      integration_id,
      user.id,
    );
    await WorkspaceService.assertOwnership(user.id, integration.workspace_id);

    const fs = await import("fs");
    if (!fs.existsSync(file_path)) {
      throw new AppError(`File not found: ${file_path}`, 400);
    }

    const jobId = await ImportService.importTelegramExport({
      filePath: file_path,
      chatId: chat_id,
      chatName: chat_name,
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
    });

    res.status(202).json({
      status: 202,
      data: { job_id: jobId },
      message:
        "Import started. Use GET /api/v1/import/status/:jobId to track progress.",
    });
  }),

  getStatus: withErrorHandler(async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;

    const status = ImportService.getStatus(jobId);

    if (!status) {
      throw new AppError("Import job not found", 404);
    }

    res.status(200).json({
      status: 200,
      data: status,
      message: `Import ${status.status}`,
    });
  }),
};
