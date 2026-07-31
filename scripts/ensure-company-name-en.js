/**
 * Ensure companies.name_en exists for Complaint English company names.
 * Safe to re-run.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [config.db.database, table, column],
  );
  return rows.length > 0;
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    if (!(await columnExists(conn, "companies", "name_en"))) {
      await conn.query(
        `ALTER TABLE companies
           ADD COLUMN name_en VARCHAR(255) NULL AFTER name`,
      );
      console.log("Added companies.name_en");
    } else {
      console.log("companies.name_en already exists");
    }

  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
