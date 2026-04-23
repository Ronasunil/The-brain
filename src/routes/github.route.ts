import { Router } from "express";
import { GitHubController } from "../controllers/github.controller";
import { authenticate } from "../lib/middleware";

const router = Router();

router.post(
  "/sync/:integrationId",
  authenticate as any,
  GitHubController.sync,
);

router.get(
  "/status/:integrationId",
  authenticate as any,
  GitHubController.status,
);

export { router as githubRouter };
