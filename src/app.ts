import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { mainRouter } from "./routes/main.route";
import { globalErrorHandler, handleInvalidRoutes } from "./error/error.handler";

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());
app.use(cookieParser());

app.use("/api/v1", mainRouter);

app.all("*", handleInvalidRoutes);
app.use(globalErrorHandler);

export { app };
