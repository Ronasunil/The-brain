import { Router } from "express";
// Mount sub-routers
import { healthRouter } from "./health.route";
import { brainRouter } from "./brain.route";
import { importRouter } from "./import.route";
import { authRouter } from "./auth.route";
import { telegramRouter } from "./telegram.route";
import { workspaceRouter } from "./workspace.route";
import { integrationRouter } from "./integration.route";
import { linearAuthRouter, linearPublicRouter } from "./linear.route";

const mainRouter = Router();

mainRouter.use("/health", healthRouter);
mainRouter.use("/brain", brainRouter);
mainRouter.use("/import", importRouter);
mainRouter.use("/auth", authRouter);
mainRouter.use("/telegram", telegramRouter);
mainRouter.use("/linear", linearPublicRouter);
mainRouter.use("/integrations/linear", linearAuthRouter);
mainRouter.use("/workspaces", workspaceRouter);
mainRouter.use("/workspaces/:workspaceId/integrations", integrationRouter);

export { mainRouter };
