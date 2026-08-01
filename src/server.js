import "./core/load-env.js";
import { createApplication } from "./app.js";
import { config } from "./core/config.js";
import { ensureCmsRbac } from "./core/ensure-cms-rbac.js";
import { logger } from "./core/logger.js";
import { seedAdminUser } from "./routes/auth.js";

const { app, pool } = createApplication();

async function boot() {
  try {
    const conn = await pool.getConnection();
    try {
      await ensureCmsRbac(conn);
    } finally {
      conn.release();
    }
    await seedAdminUser(pool);
  } catch (err) {
    logger.warn("CMS RBAC/seed skipped/failed:", err.message);
  }

  const server = app.listen(config.port, () => {
    logger.info(`CMS API listening on port ${config.port}`);
    logger.info(
      `Center identity: ${config.sharedDbName}.${config.centerUserTable}`,
    );
  });

  async function shutdown(signal) {
    logger.info(`Shutting down (${signal})...`);
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
