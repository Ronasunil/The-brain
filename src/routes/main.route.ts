import { Router } from "express";
// Mount sub-routers
import { healthRouter } from "./health.route";
import { brainRouter } from "./brain.route";
import { importRouter } from "./import.route";

const mainRouter = Router();

mainRouter.use("/health", healthRouter);
mainRouter.use("/brain", brainRouter);
mainRouter.use("/import", importRouter);

export { mainRouter };
