import { Router } from "express";
import { TelegramController } from "../controllers/telegram.controller";
import {
  validateBody,
  verifyTelegramSecret,
  loadIntegration,
} from "../lib/middleware";
import { telegramUpdateSchema } from "../lib/validations/telegram.schema";

const router = Router();

router.post(
  "/webhook/:integrationId",
  loadIntegration,
  verifyTelegramSecret,
  validateBody(telegramUpdateSchema),
  TelegramController.webhook,
);

export { router as telegramRouter };
