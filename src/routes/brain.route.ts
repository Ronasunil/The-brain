import { randomUUID } from "node:crypto";
import { Router, Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { authenticate, validateBody } from "../lib/middleware";
import {
  askQuestionSchema,
  rememberSchema,
} from "../lib/validations/brain.schema";
import { QueryService } from "../services/query.service";
import { MessageService } from "../services/message.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";
import { AuthenticatedRequest, RememberedItem } from "../lib/types";

const router = Router();

/**
 * POST /api/brain/ask
 * Ask a question to the brain (REST endpoint for future web dashboard).
 */
router.post(
  "/ask",
  validateBody(askQuestionSchema),
  withErrorHandler(async (req: Request, res: Response) => {
    const { question, workspace_id } = (req as any).validatedBody;

    const result = await QueryService.ask(
      question,
      workspace_id || DEFAULT_WORKSPACE_ID,
    );

    res.json({
      status: 200,
      data: result,
      message: "Answer generated successfully",
    });
  }),
);

/**
 * POST /api/brain/remember
 * Persist an authoritative fact into the knowledge corpus.
 * Requires authentication — user identity is recorded on the stored row.
 */
router.post(
  "/remember",
  authenticate as any,
  validateBody(rememberSchema),
  withErrorHandler(async (req: Request, res: Response) => {
    const { text, workspace_id } = (req as any).validatedBody;
    const user = (req as AuthenticatedRequest).user;

    const stored = await MessageService.ingest({
      workspace_id: workspace_id || DEFAULT_WORKSPACE_ID,
      source: "manual",
      source_message_id: `remember:${randomUUID()}`,
      user_name: user.name,
      user_id: user.id,
      chat_id: `remember:${user.id}`,
      chat_name: "Remembered notes",
      content: text,
      timestamp: new Date(),
    });

    const body: RememberedItem = {
      id: stored.id,
      content: stored.content,
      timestamp: stored.timestamp,
      created_at: stored.created_at,
    };

    res.status(201).json({
      status: 201,
      data: body,
      message: "Remembered successfully",
    });
  }),
);

export { router as brainRouter };
