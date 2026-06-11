import express from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";

const app = express();

app.use(cors({ origin: env.corsOrigin, credentials: true }));
app.use(express.json({ limit: "25mb" })); // bulk imports can be large
app.use(morgan(env.isProd ? "combined" : "dev"));

// Rate limit the API surface (NFR-4).
app.use(
  "/api",
  rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests — please slow down." },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok", service: "ill-cts" }));
app.use("/api", routes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`🚀 ILL CTS API listening on http://localhost:${env.port}`);
});
