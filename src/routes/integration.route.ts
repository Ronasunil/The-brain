import { Router } from "express";
import { IntegrationController } from "../controllers/integration.controller";
import {
  authenticate,
  validateBody,
  requireWorkspaceAccess,
} from "../lib/middleware";
import { createIntegrationSchema } from "../lib/validations/integration.schema";

const router = Router({ mergeParams: true });

router.post(
  "/",
  authenticate as any,
  requireWorkspaceAccess as any,
  validateBody(createIntegrationSchema),
  IntegrationController.create,
);

router.get(
  "/",
  authenticate as any,
  requireWorkspaceAccess as any,
  IntegrationController.list,
);

router.get(
  "/:id",
  authenticate as any,
  requireWorkspaceAccess as any,
  IntegrationController.getById,
);

router.delete(
  "/:id",
  authenticate as any,
  requireWorkspaceAccess as any,
  IntegrationController.disconnect,
);

router.delete(
  "/:id/permanent",
  authenticate as any,
  requireWorkspaceAccess as any,
  IntegrationController.remove,
);

export { router as integrationRouter };
