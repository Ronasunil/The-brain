import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { AppError } from "../lib/errors/app-error";
import { AuthRepository } from "../db/auth.repository";
import { UserRepository } from "../db/user.repository";
import { env } from "../config/env";
import {
  BCRYPT_SALT_ROUNDS,
  OTP_EXPIRY_MINUTES,
} from "../lib/constants/auth.constants";
import { UserResponse, JwtPayload } from "../lib/types/auth.types";
import {
  SignupPayload,
  LoginPayload,
  ForgotPasswordPayload,
  ResetPasswordPayload,
} from "../lib/validations/auth.schema";

export const AuthService = {
  async signup(
    payload: SignupPayload,
  ): Promise<{ token: string; user: UserResponse }> {
    // Check email uniqueness
    const existingEmail = await AuthRepository.findByEmail(payload.email);
    if (existingEmail) {
      throw new AppError("Email already exists", 409);
    }

    // Check username uniqueness
    const existingUsername = await AuthRepository.findByUsername(
      payload.username,
    );
    if (existingUsername) {
      throw new AppError("Username already exists", 409);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(
      payload.password,
      BCRYPT_SALT_ROUNDS,
    );

    // Create user record
    const user = await UserRepository.create({
      email: payload.email,
      name: payload.name,
      phone: payload.phone,
      avatar_url: payload.avatar_url,
    });

    // Create auth record linked to user
    await AuthRepository.create({
      user_id: user.id,
      email: payload.email,
      username: payload.username,
      password_hash: passwordHash,
    });

    // Generate JWT
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      token,
      user: toUserResponse(user),
    };
  },

  async login(
    payload: LoginPayload,
  ): Promise<{ token: string; user: UserResponse }> {
    // Find auth by email
    const auth = await AuthRepository.findByEmail(payload.email);
    if (!auth) {
      throw new AppError("Invalid credentials", 401);
    }

    // Check account validity
    if (!auth.is_valid) {
      throw new AppError("Account disabled", 403);
    }

    // Compare password
    const isMatch = await bcrypt.compare(payload.password, auth.password_hash);
    if (!isMatch) {
      throw new AppError("Invalid credentials", 401);
    }

    // Fetch user record
    const user = await UserRepository.findById(auth.user_id);
    if (!user) {
      throw new AppError("User not found", 401);
    }

    // Update last login
    await AuthRepository.updateLastLogin(auth.user_id);

    // Generate JWT
    const token = generateToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return {
      token,
      user: toUserResponse(user),
    };
  },

  async forgotPassword(payload: ForgotPasswordPayload): Promise<void> {
    const auth = await AuthRepository.findByEmail(payload.email);
    if (!auth) return;

    // Generate 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

    await AuthRepository.setOtp(auth.user_id, otp, expiresAt);

    // Log OTP to console (email delivery out of scope)
    console.log(
      `[AUTH] OTP for ${payload.email}: ${otp} (expires at ${expiresAt.toISOString()})`,
    );
  },

  async resetPassword(payload: ResetPasswordPayload): Promise<void> {
    const auth = await AuthRepository.findByEmail(payload.email);
    if (!auth) {
      throw new AppError("User not found", 404);
    }

    // Validate OTP
    if (!auth.otp || auth.otp !== payload.otp) {
      throw new AppError("Invalid OTP", 400);
    }

    // Check OTP expiry
    if (!auth.otp_expires_at || new Date(auth.otp_expires_at) < new Date()) {
      throw new AppError("OTP expired", 400);
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(
      payload.new_password,
      BCRYPT_SALT_ROUNDS,
    );

    // Update password + password_changed_at
    await AuthRepository.updatePassword(auth.user_id, passwordHash);

    // Clear OTP
    await AuthRepository.clearOtp(auth.user_id);
  },
};

function generateToken(payload: Omit<JwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as any,
  });
}

function toUserResponse(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  avatar_url: string | null;
  phone: string | null;
  created_at: Date;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatar_url: user.avatar_url,
    phone: user.phone,
    created_at: user.created_at,
  };
}
