import { Router, Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { validateBody } from "../lib/middleware";
import { askQuestionSchema } from "../lib/validations/brain.schema";
import { QueryService } from "../services/query.service";
import { DEFAULT_WORKSPACE_ID } from "../lib/constants/app.constants";

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

export { router as brainRouter };
