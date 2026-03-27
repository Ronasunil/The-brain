import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors/app-error";

/**
 * Return a success JSON response matching the existing API shape.
 */
export function success<T>(data: T, message: string, status = 200) {
  return NextResponse.json({ status, data, message }, { status });
}

/**
 * Catch-all error handler for API route handlers.
 * Returns consistent { status, data, message } shape.
 */
export function handleError(error: unknown) {
  if (error instanceof AppError) {
    return NextResponse.json(
      { status: error.statusCode, data: null, message: error.message },
      { status: error.statusCode },
    );
  }

  if (error instanceof ZodError) {
    const msg = error.errors.map((e) => e.message).join(", ");
    return NextResponse.json(
      { status: 400, data: null, message: msg },
      { status: 400 },
    );
  }

  console.error("Unhandled API error:", error);
  return NextResponse.json(
    { status: 500, data: null, message: "Internal server error" },
    { status: 500 },
  );
}
