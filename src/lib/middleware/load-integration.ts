import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/app-error";
import { IntegrationRepository } from "../../db/integration.repository";
import { Integration } from "../types/integration.types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      integration?: Integration;
    }
  }
}

/**
 * Loads the integration identified by :integrationId from the URL and attaches
 * it to req.integration. Rejects with 404 if missing, 410 if disconnected.
 * Designed to run BEFORE verifyTelegramSecret so the secret is available.
 */
export function loadIntegration(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const integrationId = req.params.integrationId as string | undefined;
  if (!integrationId) {
    throw new AppError("integrationId is required", 400);
  }

  IntegrationRepository.findById(integrationId)
    .then((integration) => {
      if (!integration) {
        throw new AppError("Integration not found", 404);
      }
      if (integration.status === "disconnected") {
        throw new AppError("Integration disconnected", 410);
      }
      req.integration = integration;
      next();
    })
    .catch(next);
}
