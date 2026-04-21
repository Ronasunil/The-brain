import { env } from "../../config/env";
import { CookieOptions } from "express";

export const BCRYPT_SALT_ROUNDS = 12;

export const OTP_EXPIRY_MINUTES = 15;

export const COOKIE_NAME = "token";

export const USER_ROLES = ["admin", "user"] as const;

export const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};
