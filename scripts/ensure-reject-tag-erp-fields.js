/**
 * Ensure reject_records columns for Tag fields snapshotted from ERP GET /api/pdr.
 * Read-only from ERP — writes only to CMS reject_records.
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

const COLUMNS = [
  {
    name: "cut_qty",
    sql: "ADD COLUMN cut_qty INT NULL AFTER size",
  },
  {
    name: "item_code",
    sql: "ADD COLUMN item_code VARCHAR(80) NULL AFTER cut_qty",
  },
  {
    name: "big_sheet_qty",
    sql: "ADD COLUMN big_sheet_qty DECIMAL(14, 2) NULL AFTER item_code",
  },
  {
    name: "big_sheet_size",
    sql: "ADD COLUMN big_sheet_size VARCHAR(40) NULL AFTER big_sheet_qty",
  },
  {
    name: "small_sheet_size",
    sql: "ADD COLUMN small_sheet_size VARCHAR(40) NULL AFTER big_sheet_size",
  },
];

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    for (const col of COLUMNS) {
      if (await columnExists(conn, "reject_records", col.name)) {
        console.log(`skip ${col.name} (exists)`);
        continue;
      }
      await conn.query(`ALTER TABLE reject_records ${col.sql}`);
      console.log(`Added reject_records.${col.name}`);
    }
    console.log("Reject Tag ERP fields ready");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
