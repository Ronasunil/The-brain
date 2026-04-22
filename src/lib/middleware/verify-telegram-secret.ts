import crypto from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/app-error";

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Verifies the X-Telegram-Bot-Api-Secret-Token header against the expected
 * secret stored on req.integration (set by loadIntegration). Must run AFTER
 * loadIntegration.
 */
export function verifyTelegramSecret(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.integration) {
    throw new AppError(
      "verifyTelegramSecret must run after loadIntegration",
      500,
    );
  }

  const received = req.header(TELEGRAM_SECRET_HEADER) ?? "";
  const expected = req.integration.webhook_secret;

  const a = Buffer.from(received);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError("Unauthorized", 401);
  }

  next();
}
