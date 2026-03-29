import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/app-error";
import { AuthRepository } from "../../db/auth.repository";
import { UserRepository } from "../../db/user.repository";
import { env } from "../../config/env";
import { COOKIE_NAME } from "../constants/auth.constants";
import { JwtPayload, AuthenticatedRequest } from "../types/auth.types";

/**
 * Auth middleware — validates JWT from cookie, checks account validity,
 * checks password_changed_at vs token.iat, and attaches user to req.
 */
export function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    throw new AppError("Authentication required", 401);
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
  } catch {
    throw new AppError("Invalid or expired token", 401);
  }

  // Fetch auth record, check validity, check password_changed_at, fetch user — all async
  (async () => {
    const auth = await AuthRepository.findByUserId(decoded.userId);
    if (!auth) {
      throw new AppError("Authentication required", 401);
    }

    if (!auth.is_valid) {
      throw new AppError("Account disabled", 403);
    }

    // If password was changed after token was issued, reject
    if (auth.password_changed_at && decoded.iat) {
      const changedAt = Math.floor(
        new Date(auth.password_changed_at).getTime() / 1000,
      );
      if (changedAt > decoded.iat) {
        throw new AppError("Password changed, please login again", 401);
      }
    }

    const user = await UserRepository.findById(decoded.userId);
    if (!user) {
      throw new AppError("User not found", 401);
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar_url: user.avatar_url,
      phone: user.phone,
      created_at: user.created_at,
    };

    next();
  })().catch(next);
}
