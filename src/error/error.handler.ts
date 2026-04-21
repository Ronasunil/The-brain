import { NextFunction, Request, Response } from "express";
import httpStatusCodes from "http-status-codes";
import { AppError } from "../lib/errors/app-error";

const handleInvalidRoutes = function (req: Request, res: Response): void {
  const msg = `Route you requested does not exist: ${req.method} ${req.originalUrl}`;
  res.status(httpStatusCodes.NOT_FOUND).json({
    status: httpStatusCodes.NOT_FOUND,
    data: null,
    message: msg,
  });
};

const globalErrorHandler = function (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ status: 400, data: null, message: "Invalid request body" });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: err.statusCode,
      data: null,
      message: err.message,
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(httpStatusCodes.INTERNAL_SERVER_ERROR).json({
    status: httpStatusCodes.INTERNAL_SERVER_ERROR,
    data: null,
    message: "Internal Server Error",
  });
};

export { globalErrorHandler, handleInvalidRoutes };
