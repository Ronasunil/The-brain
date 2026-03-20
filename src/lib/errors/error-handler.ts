import { Request, Response, NextFunction } from "express";
import { AppError } from "./app-error";
import { ApiResponse } from "../types/api.types";

/**
 * Express async error handler wrapper.
 * Wraps route handlers so thrown errors are caught and returned
 * in the standard { status, data, message } shape.
 */
export function withErrorHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof AppError) {
        const body: ApiResponse<null> = {
          status: error.statusCode,
          data: null,
          message: error.message,
        };
        res.status(error.statusCode).json(body);
        return;
      }

      console.error("Unhandled error:", error);
      const body: ApiResponse<null> = {
        status: 500,
        data: null,
        message: "Internal Server Error",
      };
      res.status(500).json(body);
    }
  };
}
