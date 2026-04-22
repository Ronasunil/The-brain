import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AppError } from "../lib/errors/app-error";
import { TelegramBotService } from "../services/telegram.service";
import { TelegramUpdate } from "../lib/validations/telegram.schema";

export const TelegramController = {
  webhook: withErrorHandler(async (req: Request, res: Response) => {
    const integration = req.integration;
    if (!integration) {
      throw new AppError("Integration not loaded", 500);
    }

    const update = (req as any).validatedBody as TelegramUpdate;
    TelegramBotService.processUpdate(integration, update);

    res.status(200).json({
      status: 200,
      data: null,
      message: "ok",
    });
  }),
};
