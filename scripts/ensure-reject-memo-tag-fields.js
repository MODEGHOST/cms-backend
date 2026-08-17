/**
 * Ensure reject_records columns for Memo/Tag PDF overrides.
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
    name: "memo_lot_no",
    sql: "ADD COLUMN memo_lot_no VARCHAR(80) NULL AFTER remark",
  },
  {
    name: "pallet_count",
    sql: "ADD COLUMN pallet_count INT NULL AFTER memo_lot_no",
  },
  {
    name: "pallet_lines",
    sql: "ADD COLUMN pallet_lines JSON NULL AFTER pallet_count",
  },
  {
    name: "repair_with_qty",
    sql: "ADD COLUMN repair_with_qty DECIMAL(14, 2) NULL AFTER pallet_lines",
  },
  {
    name: "memo_customer_return_qty",
    sql: "ADD COLUMN memo_customer_return_qty DECIMAL(14, 2) NULL AFTER repair_with_qty",
  },
  {
    name: "tag_ship_date",
    sql: "ADD COLUMN tag_ship_date DATE NULL AFTER memo_customer_return_qty",
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
    console.log("Reject Memo/Tag fields ready");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
