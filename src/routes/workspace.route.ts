import { Router } from "express";
import { WorkspaceController } from "../controllers/workspace.controller";
import { authenticate, validateBody } from "../lib/middleware";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from "../lib/validations/workspace.schema";

const router = Router();

router.post(
  "/",
  authenticate as any,
  validateBody(createWorkspaceSchema),
  WorkspaceController.create,
);

router.get("/", authenticate as any, WorkspaceController.list);

router.get("/:id", authenticate as any, WorkspaceController.getById);

router.patch(
  "/:id",
  authenticate as any,
  validateBody(updateWorkspaceSchema),
  WorkspaceController.update,
);

router.delete("/:id", authenticate as any, WorkspaceController.delete);

export { router as workspaceRouter };
