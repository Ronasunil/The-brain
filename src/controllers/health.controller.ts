import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";

export const HealthController = {
  check: withErrorHandler(async (_req: Request, res: Response) => {
    res.status(200).json({
      status: 200,
      data: {
        service: "orgbrain",
        version: "0.1.0",
        uptime: process.uptime(),
      },
      message: "OrgBrain is running",
    });
  }),
};
