import { Router } from "express";
import { OperationalMemoryController } from "../controllers/operational-memory.controller";
import {
  authenticate,
  requireWorkspaceAccess,
  validateBody,
} from "../lib/middleware";
import { updateOperationalMemorySchema } from "../lib/validations/operational-memory.schema";

const router = Router({ mergeParams: true });

router.use(authenticate as any, requireWorkspaceAccess as any);

router.get("/operational-memories", OperationalMemoryController.list);
router.get("/operational-memories/:memoryId", OperationalMemoryController.get);
router.patch(
  "/operational-memories/:memoryId",
  validateBody(updateOperationalMemorySchema),
  OperationalMemoryController.update,
);
router.post(
  "/operational-memories/:memoryId/approve",
  OperationalMemoryController.approve,
);
router.post(
  "/operational-memories/:memoryId/reject",
  OperationalMemoryController.reject,
);
router.get("/operational-graph", OperationalMemoryController.graph);
router.get("/agent-runs", OperationalMemoryController.agentRuns);

export { router as operationalMemoryRouter };
