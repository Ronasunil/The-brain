import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { healthRouter } from "./routes/health.route";
import { brainRouter } from "./routes/brain.route";

const app = express();

// ─── Global Middleware ──────────────────────────────
app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

// ─── Routes ─────────────────────────────────────────
app.use("/api/health", healthRouter);
app.use("/api/brain", brainRouter);

// ─── 404 Handler ────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    status: 404,
    data: null,
    message: "Route not found",
  });
});

export { app };
