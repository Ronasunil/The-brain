import { Router } from "express";
import { TokenUsageController } from "../controllers/token-usage.controller";
import { authenticate, requireWorkspaceAccess } from "../lib/middleware";

const router = Router({ mergeParams: true });

router.use(authenticate as any, requireWorkspaceAccess as any);

router.get("/token-usage", TokenUsageController.list);
router.get("/token-usage/summary", TokenUsageController.summary);

export { router as tokenUsageRouter };
