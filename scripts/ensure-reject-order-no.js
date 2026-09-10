/**
 * Add reject_records.order_no (ERP Sequence / Tag Order No.).
 * Keeps order_qty for Quantity — both fields are populated from ERP.
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
    if (await columnExists(conn, "reject_records", "order_no")) {
      console.log("skip order_no (exists)");
    } else {
      await conn.query(
        `ALTER TABLE reject_records
           ADD COLUMN order_no VARCHAR(80) NULL AFTER sale_order_no`,
      );
      console.log("Added reject_records.order_no");
    }
    console.log("Reject order_no ready");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
