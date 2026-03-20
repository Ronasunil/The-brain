import { Router, Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { MessageService } from "../services/message.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";

const router = Router();

/**
 * GET /api/health
 * Health check endpoint.
 */
router.get(
  "/",
  withErrorHandler(async (_req: Request, res: Response) => {
    const messageCount = await MessageService.getCount(DEFAULT_WORKSPACE_ID);

    res.json({
      status: 200,
      data: {
        service: "orgbrain",
        version: "0.1.0",
        uptime: process.uptime(),
        messages_stored: messageCount,
      },
      message: "OrgBrain is running",
    });
  }),
);

export { router as healthRouter };
