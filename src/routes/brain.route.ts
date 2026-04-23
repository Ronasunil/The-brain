import { Router } from "express";
import { BrainController } from "../controllers/brain.controller";
import {
  authenticate,
  validateBody,
  requireWorkspaceAccess,
} from "../lib/middleware";
import {
  askQuestionSchema,
  rememberSchema,
} from "../lib/validations/brain.schema";

const router = Router();

router.post(
  "/ask",
  authenticate as any,
  validateBody(askQuestionSchema),
  requireWorkspaceAccess as any,
  BrainController.ask,
);

router.post(
  "/remember",
  authenticate as any,
  validateBody(rememberSchema),
  requireWorkspaceAccess as any,
  BrainController.remember,
);

export { router as brainRouter };
