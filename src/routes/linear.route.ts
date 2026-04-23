import { Router } from "express";
import { LinearController } from "../controllers/linear.controller";
import { authenticate, validateBody } from "../lib/middleware";
import { linearConnectSchema } from "../lib/validations/linear.schema";

/**
 * Two routers are exported:
 *
 * - linearAuthRouter: authenticated OAuth + admin routes, mounted under
 *     /api/v1/integrations/linear (JSON-body, cookie-authenticated).
 *
 * - linearWebhookRouter: public webhook route, mounted under /api/v1/linear.
 *     The raw body is captured by the global express.json({ verify }) hook
 *     in app.ts and exposed as req.rawBody for HMAC verification.
 */

const linearAuthRouter = Router();

linearAuthRouter.post(
  "/connect",
  authenticate as any,
  validateBody(linearConnectSchema),
  LinearController.connect,
);

linearAuthRouter.get("/callback", LinearController.callback);

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

const linearWebhookRouter = Router();

linearWebhookRouter.post(
  "/webhook/:integrationId",
  LinearController.webhook,
);

export { linearAuthRouter, linearWebhookRouter };
