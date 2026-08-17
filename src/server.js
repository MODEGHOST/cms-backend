import "./core/load-env.js";
import { createApplication } from "./app.js";
import { config } from "./core/config.js";
import { ensureCmsRbac } from "./core/ensure-cms-rbac.js";
import { ensurePasswordResetTokens } from "./core/ensure-password-reset-tokens.js";
import { ensureTelegramChatId } from "./core/ensure-telegram-chat-id.js";
import { ensureDocumentDeadlineColumns } from "./core/ensure-document-deadline.js";
import { ensureOrderDailyCount } from "./core/ensure-order-daily-count.js";
import { ensureDeptTargetSettings } from "./core/ensure-dept-target-settings.js";
import { ensureListIndexes } from "./core/ensure-list-indexes.js";
import { ensureRecordProblems } from "./core/ensure-record-problems.js";
import { logger } from "./core/logger.js";
import { seedAdminUser } from "./routes/auth.js";

const { app, pool, telegramAuthBot, documentDeadlineWatcher } = createApplication();

async function boot() {
  try {
    const conn = await pool.getConnection();
    try {
      await ensureCmsRbac(conn);
      await ensurePasswordResetTokens(conn);
      await ensureTelegramChatId(conn, {
        sharedDbName: config.sharedDbName,
        centerUserTable: config.centerUserTable,
      });
      await ensureDocumentDeadlineColumns(conn);
      await ensureOrderDailyCount(conn);
      await ensureDeptTargetSettings(conn);
      await ensureListIndexes(conn);
      await ensureRecordProblems(conn);
    } finally {
      conn.release();
    }
    await seedAdminUser(pool);
  } catch (err) {
    logger.warn("CMS RBAC/seed skipped/failed:", err.message);
  }

  const server = app.listen(config.port, () => {
    logger.info(`CMS API listening on port ${config.port}`);
    if (config.basePath) {
      logger.info(`IIS BASE_PATH ${config.basePath} (stripped before routes)`);
    }
    logger.info(`CORS origins: ${config.corsOrigins.join(", ")}`);
    logger.info(
      `Center identity: ${config.sharedDbName}.${config.centerUserTable}`,
    );
  });

  telegramAuthBot?.start();
  documentDeadlineWatcher?.start();

  async function shutdown(signal) {
    logger.info(`Shutting down (${signal})...`);
    telegramAuthBot?.stop();
    documentDeadlineWatcher?.stop();
    server.close(async () => {
      try {
        await pool.end();
      } catch (err) {
        logger.error(err);
      }
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

boot().catch((err) => {
  logger.error(err);
  process.exit(1);
});
