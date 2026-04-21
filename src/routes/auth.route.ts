import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";
import { validateBody, authenticate } from "../lib/middleware";
import {
  signupSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from "../lib/validations/auth.schema";


const router = Router();

router.post("/signup", validateBody(signupSchema), AuthController.signup);
router.post("/login", validateBody(loginSchema), AuthController.login);
router.post("/logout", AuthController.logout);
router.post(
  "/forgot-password",
  validateBody(forgotPasswordSchema),
  AuthController.forgotPassword,
);
router.post(
  "/reset-password",
  validateBody(resetPasswordSchema),
  AuthController.resetPassword,
);
router.get("/me", authenticate as any, AuthController.me);

export { router as authRouter };
