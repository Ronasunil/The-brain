import { Router, Request, Response } from "express";
import { AuthController } from "../controllers/auth.controller";
import { validateBody, authenticate } from "../lib/middleware";
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../lib/validations/auth.schema";
import { AuthenticatedRequest } from "../lib/types/auth.types";

const router = Router();

const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ status: 405, data: null, message: "Method Not Allowed" });

router.post("/signup", validateBody(signupSchema), AuthController.signup);
router.all("/signup", methodNotAllowed);

router.post("/login", validateBody(loginSchema), AuthController.login);
router.all("/login", methodNotAllowed);

router.post("/logout", AuthController.logout);
router.all("/logout", methodNotAllowed);

router.post("/forgot-password", validateBody(forgotPasswordSchema), AuthController.forgotPassword);
router.all("/forgot-password", methodNotAllowed);

router.post("/reset-password", validateBody(resetPasswordSchema), AuthController.resetPassword);
router.all("/reset-password", methodNotAllowed);

router.get("/me", authenticate as any, AuthController.me);
router.all("/me", methodNotAllowed);

export { router as authRouter };
