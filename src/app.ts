import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { mainRouter } from "./routes/main.route";
import { globalErrorHandler, handleInvalidRoutes } from "./error/error.handler";
import { env } from "./config/env";

const app = express();



app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: env.CLIENT_ORIGIN,
    credentials: true,
  
  }),
);
app.use(morgan("dev"));
// Raw body is only captured on HMAC-signed webhook paths. Avoids doubling
// memory on every request (imports, brain/ask payloads, etc.).
const WEBHOOK_PATH_RE = /^\/api\/v1\/(linear|telegram)\/webhook\//;
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if (WEBHOOK_PATH_RE.test((req as any).originalUrl ?? (req as any).url ?? "")) {
        (req as any).rawBody = buf;
      }
    },
  }),
);
app.use(cookieParser());

app.get("/", (_req, res) => res.sendStatus(200));

app.use("/api/v1", mainRouter);

app.all("*", handleInvalidRoutes);
app.use(globalErrorHandler);

export { app };
