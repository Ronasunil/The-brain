import { Router } from "express";
import { LinearController } from "../controllers/linear.controller";
import { authenticate, validateBody } from "../lib/middleware";
import { linearConnectSchema } from "../lib/validations/linear.schema";

/**
 * Two routers are exported:
 *
 * - linearAuthRouter: authenticated admin routes, mounted under
 *     /api/v1/integrations/linear (JSON-body, cookie-authenticated).
 *     Contains /connect, /:id/status, /:id/resync.
 *
 * - linearPublicRouter: public endpoints Linear itself hits, mounted under
 *     /api/v1/linear. Contains the OAuth callback (browser redirect) and the
 *     webhook. Short URL by design — matches what you register at
 *     https://linear.app/settings/api/applications.
 *
 * Raw body for the webhook is captured by the global express.json({ verify })
 * hook in app.ts and exposed as req.rawBody for HMAC verification.
 */

const linearAuthRouter = Router();

linearAuthRouter.post(
  "/connect",
  authenticate as any,
  validateBody(linearConnectSchema),
  LinearController.connect,
);

linearAuthRouter.get(
  "/:id/status",
  authenticate as any,
  LinearController.status,
);

linearAuthRouter.post(
  "/:id/resync",
  authenticate as any,
  LinearController.resync,
);

const linearPublicRouter = Router();

// Public — Linear browser redirect target after user consents on OAuth.
linearPublicRouter.get("/callback", LinearController.callback);

// Public — Linear server posts webhook events here.
linearPublicRouter.post("/webhook/:integrationId", LinearController.webhook);

export { linearAuthRouter, linearPublicRouter };
