import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { AppError } from "../errors/app-error";

/**
 * Express middleware that validates req.body against a Zod schema.
 * On success, attaches parsed data to req.validatedBody.
 * On failure, throws AppError(400).
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new AppError(result.error.errors[0].message, 400);
    }
    (req as any).validatedBody = result.data;
    next();
  };
}
