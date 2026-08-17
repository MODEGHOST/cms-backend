import "./core/load-env.js";
import "./core/node16-compat.js";
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
import { registerPublicAuthRoutes } from "./routes/public-auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMasterRoutes } from "./routes/masters.js";
import { registerRejectRoutes } from "./routes/rejects.js";
import { registerComplaintRoutes } from "./routes/complaints.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerActivityLogRoutes } from "./routes/activity-logs.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerErpRoutes } from "./routes/erp.js";
import { createEmailService, createTelegramService } from "./services/communications.js";
import { createTelegramAuthBot } from "./services/telegram-auth-bot.js";
import { createDocumentDeadlineWatcher } from "./services/document-deadline-watcher.js";

export function createApplication() {
  const app = express();
  app.set("trust proxy", config.trustProxy);

  const pool = createPool();
  const requireAuth = createAuth(pool);
  const sendEmail = createEmailService({ config, logger });
  const telegram = createTelegramService({ config, logger });
  const telegramAuthBot = createTelegramAuthBot({ pool, config, logger });
  const documentDeadlineWatcher = createDocumentDeadlineWatcher({
    pool,
    telegram,
    config,
    logger,
  });

  // When IIS does not strip the app path, Node still sees /lfb_cms/backend/...
  if (config.basePath) {
    const prefix = config.basePath;
    app.use((req, _res, next) => {
      if (req.url === prefix || req.url.startsWith(`${prefix}/`)) {
        const stripped = req.url.slice(prefix.length);
        req.url = stripped.length ? stripped : "/";
      }
      next();
    });
  }

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
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
  registerAuthRoutes(app, { pool, wrap, requireAuth, telegram });
  registerPublicAuthRoutes(app, { pool, wrap, sendEmail, telegramAuthBot });
  registerMasterRoutes(app, { pool, wrap, requireAuth });
  registerRejectRoutes(app, { pool, wrap, requireAuth, telegram });
  registerComplaintRoutes(app, { pool, wrap, requireAuth, telegram });
  registerDashboardRoutes(app, { pool, wrap, requireAuth });
  registerActivityLogRoutes(app, { pool, wrap, requireAuth });
  registerSystemRoutes(app, { pool, wrap, requireAuth });
  registerErpRoutes(app, { wrap, requireAuth });

  app.use((err, _req, res, _next) => {
    logger.error(err);
    const body = {
      message: err.message || "Internal Server Error",
    };
    if (err.code) body.code = err.code;
    if (err.errors) body.errors = err.errors;
    res.status(err.status || 500).json(body);
  });

  return { app, pool, telegramAuthBot, documentDeadlineWatcher };
}
