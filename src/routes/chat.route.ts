import { Router } from "express";
import { ChatController } from "../controllers/chat.controller";
import { authenticate, requireWorkspaceAccess } from "../lib/middleware";

const router = Router();

router.get(
  "/history",
  authenticate as any,
  requireWorkspaceAccess as any,
  ChatController.history,
);

export { router as chatRouter };
