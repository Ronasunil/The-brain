import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { TokenUsageService } from "../services/token-usage.service";

function workspaceId(req: Request): string {
  return req.params.workspaceId as string;
}

export const TokenUsageController = {
  list: withErrorHandler(async (req: Request, res: Response) => {
    const events = await TokenUsageService.list(workspaceId(req), {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.status(200).json({
      status: 200,
      data: events,
      message: "Token usage events fetched",
    });
  }),

  summary: withErrorHandler(async (req: Request, res: Response) => {
    const summary = await TokenUsageService.summary(workspaceId(req), {
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    });

    res.status(200).json({
      status: 200,
      data: summary,
      message: "Token usage summary fetched",
    });
  }),
};
