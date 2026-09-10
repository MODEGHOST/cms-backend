/**
 * Ensure problems.image_file exists for master problem reference photos.
 * Usage: npm run db:ensure-problem-image
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { ensureProblemImage } from "../src/core/ensure-problem-image.js";

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    await ensureProblemImage(conn);
    console.log("problems.image_file ready");
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
