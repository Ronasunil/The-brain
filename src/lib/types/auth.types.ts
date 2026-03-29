import { Request } from "express";

/**
 * Full auth table row.
 */
export interface AuthRecord {
  id: string;
  user_id: string;
  email: string;
  username: string;
  password_hash: string;
  is_valid: boolean;
  otp: string | null;
  otp_expires_at: Date | null;
  password_changed_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Full users table row.
 */
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  avatar_url: string | null;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Safe user data for API responses (no sensitive fields).
 */
export interface UserResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  avatar_url: string | null;
  phone: string | null;
  created_at: Date;
}

/**
 * JWT token payload.
 */
export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Express Request extended with authenticated user.
 */
export interface AuthenticatedRequest extends Request {
  user: UserResponse;
}
