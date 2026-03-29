import { Request, Response } from "express";
import { withErrorHandler } from "../lib/errors";
import { AuthService } from "../services/auth.service";
import { COOKIE_NAME, COOKIE_OPTIONS } from "../lib/constants/auth.constants";
import { AuthenticatedRequest } from "../lib/types/auth.types";
import {
  SignupPayload,
  LoginPayload,
  ForgotPasswordPayload,
  ResetPasswordPayload,
} from "../lib/validations/auth.schema";

export const AuthController = {
  signup: withErrorHandler(async (req: Request, res: Response) => {
    const payload = (req as any).validatedBody as SignupPayload;
    const { token, user } = await AuthService.signup(payload);

    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    res.status(201).json({
      status: 201,
      data: user,
      message: "User created successfully",
    });
  }),

  login: withErrorHandler(async (req: Request, res: Response) => {
    const payload = (req as any).validatedBody as LoginPayload;
    const { token, user } = await AuthService.login(payload);

    res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
    res.status(200).json({
      status: 200,
      data: user,
      message: "Login successful",
    });
  }),

  logout: withErrorHandler(async (_req: Request, res: Response) => {
    res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
    res.status(200).json({
      status: 200,
      data: null,
      message: "Logout successful",
    });
  }),

  forgotPassword: withErrorHandler(async (req: Request, res: Response) => {
    const payload = (req as any).validatedBody as ForgotPasswordPayload;
    await AuthService.forgotPassword(payload);

    res.status(200).json({
      status: 200,
      data: null,
      message: "OTP sent successfully",
    });
  }),

  resetPassword: withErrorHandler(async (req: Request, res: Response) => {
    const payload = (req as any).validatedBody as ResetPasswordPayload;
    await AuthService.resetPassword(payload);

    res.status(200).json({
      status: 200,
      data: null,
      message: "Password reset successfully",
    });
  }),

  me: withErrorHandler(async (req: Request, res: Response) => {
    const user = (req as AuthenticatedRequest).user;

    res.status(200).json({
      status: 200,
      data: user,
      message: "User fetched successfully",
    });
  }),
};
