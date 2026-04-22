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
app.use(express.json());
app.use(cookieParser());

app.get("/", (_req, res) => res.sendStatus(200));

app.use("/api/v1", mainRouter);

app.all("*", handleInvalidRoutes);
app.use(globalErrorHandler);

export { app };
