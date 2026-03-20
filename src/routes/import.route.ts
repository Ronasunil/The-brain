import { Router, Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { ImportService } from "../services/import.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";

const router = Router();

/**
 * POST /api/import/telegram
 * Import a Telegram Desktop export JSON file.
 *
 * Body:
 * {
 *   "file_path": "/absolute/path/to/result.json",
 *   "chat_id": "996657124",
 *   "chat_name": "Infra Team"
 *   "workspace_id": "default" (optional)
 * }
 *
 * Returns a job ID to track progress.
 */
router.post(
  "/telegram",
  withErrorHandler(async (req: Request, res: Response) => {
    const { file_path, chat_id, chat_name, workspace_id } = req.body;

    if (!file_path || !chat_id || !chat_name) {
      throw new AppError("file_path, chat_id, and chat_name are required", 400);
    }

    // Check file exists
    const fs = await import("fs");
    if (!fs.existsSync(file_path)) {
      throw new AppError(`File not found: ${file_path}`, 400);
    }

    // Start import (returns immediately with job ID)
    const jobId = await ImportService.importTelegramExport(
      file_path,
      chat_id,
      chat_name,
      workspace_id || DEFAULT_WORKSPACE_ID,
    );

    res.status(202).json({
      status: 202,
      data: { job_id: jobId },
      message:
        "Import started. Use GET /api/import/status/:jobId to track progress.",
    });
  }),
);

/**
 * GET /api/import/status/:jobId
 * Check the status of an import job.
 */
router.get(
  "/status/:jobId",
  withErrorHandler(async (req: Request, res: Response) => {
    const jobId = req.params.jobId as string;

    const status = ImportService.getStatus(jobId);

    if (!status) {
      throw new AppError("Import job not found", 404);
    }

    res.json({
      status: 200,
      data: status,
      message: `Import ${status.status}`,
    });
  }),
);

export { router as importRouter };
