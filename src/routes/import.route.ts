import { Router } from "express";
import { ImportController } from "../controllers/import.controller";
import { authenticate } from "../lib/middleware";

const router = Router();

router.post("/telegram", authenticate as any, ImportController.importTelegram);
router.get("/status/:jobId", authenticate as any, ImportController.getStatus);

export { router as importRouter };
