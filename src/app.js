import "./core/load-env.js";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { config } from "./core/config.js";
import { createPool } from "./core/db.js";
import { logger } from "./core/logger.js";
import { createAuth } from "./middleware/auth.js";
import { wrap } from "./middleware/async-handler.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMasterRoutes } from "./routes/masters.js";
import { registerRejectRoutes } from "./routes/rejects.js";
import { registerComplaintRoutes } from "./routes/complaints.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerActivityLogRoutes } from "./routes/activity-logs.js";

export function createApplication() {
  const app = express();
  app.set("trust proxy", config.trustProxy);

  const pool = createPool();
  const requireAuth = createAuth();

  app.use(helmet());
  app.use(
    cors({
      origin: [config.frontendUrl, "http://127.0.0.1:5173"],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());

  app.use((req, _res, next) => {
    req.pool = pool;
    next();
  });

  registerHealthRoutes(app);
  registerAuthRoutes(app, { pool, wrap, requireAuth });
  registerMasterRoutes(app, { pool, wrap, requireAuth });
  registerRejectRoutes(app, { pool, wrap, requireAuth });
  registerComplaintRoutes(app, { pool, wrap, requireAuth });
  registerDashboardRoutes(app, { pool, wrap, requireAuth });
  registerActivityLogRoutes(app, { pool, wrap, requireAuth });

  app.use((err, _req, res, _next) => {
    logger.error(err);
    res.status(err.status || 500).json({
      message: err.message || "Internal Server Error",
    });
  });

  return { app, pool };
}
