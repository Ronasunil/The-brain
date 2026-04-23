import { Router } from "express";
// Mount sub-routers
import { healthRouter } from "./health.route";
import { brainRouter } from "./brain.route";
import { chatRouter } from "./chat.route";
import { importRouter } from "./import.route";
import { authRouter } from "./auth.route";
import { telegramRouter } from "./telegram.route";
import { workspaceRouter } from "./workspace.route";
import { integrationRouter } from "./integration.route";
import { githubRouter } from "./github.route";

const mainRouter = Router();

mainRouter.use("/health", healthRouter);
mainRouter.use("/brain", brainRouter);
mainRouter.use("/brain/chat", chatRouter);
mainRouter.use("/import", importRouter);
mainRouter.use("/auth", authRouter);
mainRouter.use("/telegram", telegramRouter);
mainRouter.use("/github", githubRouter);
mainRouter.use("/workspaces", workspaceRouter);
mainRouter.use("/workspaces/:workspaceId/integrations", integrationRouter);

export { mainRouter };
