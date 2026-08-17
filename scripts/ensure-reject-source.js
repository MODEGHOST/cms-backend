/**
 * Ensure reject_records can mark rows created from Complaint.
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

async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [config.db.database, table, indexName],
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
    if (!(await columnExists(conn, "reject_records", "source"))) {
      await conn.query(`
        ALTER TABLE reject_records
          ADD COLUMN source VARCHAR(20) NULL AFTER remark
      `);
      console.log("Added reject_records.source");
    }

    if (!(await columnExists(conn, "reject_records", "source_complaint_id"))) {
      await conn.query(`
        ALTER TABLE reject_records
          ADD COLUMN source_complaint_id BIGINT UNSIGNED NULL AFTER source
      `);
      console.log("Added reject_records.source_complaint_id");
    }

    if (!(await indexExists(conn, "reject_records", "idx_reject_source"))) {
      await conn.query(`ALTER TABLE reject_records ADD KEY idx_reject_source (source)`);
      console.log("Added idx_reject_source");
    }

    if (!(await indexExists(conn, "reject_records", "idx_reject_source_complaint"))) {
      await conn.query(
        `ALTER TABLE reject_records ADD KEY idx_reject_source_complaint (source_complaint_id)`,
      );
      console.log("Added idx_reject_source_complaint");
    }

    console.log("reject source columns ready");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
