/**
 * Ensure reject_records.flute_id exists (รับลอนจาก ERP / Complaint).
 * Safe to re-run.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { parseFluteFromSize } from "../src/utils/parse-flute-from-size.js";

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

async function constraintExists(conn, name) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'reject_records'
        AND CONSTRAINT_NAME = ?
      LIMIT 1`,
    [config.db.database, name],
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
    if (!(await columnExists(conn, "reject_records", "flute_id"))) {
      await conn.query(`
        ALTER TABLE reject_records
          ADD COLUMN flute_id BIGINT UNSIGNED NULL AFTER machine_id
      `);
      console.log("Added reject_records.flute_id");
    } else {
      console.log("skip flute_id (exists)");
    }

    if (!(await constraintExists(conn, "fk_reject_flute"))) {
      await conn.query(`
        ALTER TABLE reject_records
          ADD CONSTRAINT fk_reject_flute
            FOREIGN KEY (flute_id) REFERENCES flutes (id)
            ON UPDATE CASCADE ON DELETE SET NULL
      `);
      console.log("Added fk_reject_flute");
    } else {
      console.log("skip fk_reject_flute (exists)");
    }

    // Backfill from linked complaint when reject has no flute yet
    const [fromComplaint] = await conn.query(`
      UPDATE reject_records rr
      INNER JOIN complaint_records cr ON cr.id = rr.source_complaint_id
      SET rr.flute_id = cr.flute_id
      WHERE rr.flute_id IS NULL
        AND cr.flute_id IS NOT NULL
    `);
    console.log(
      `Backfilled flute_id from complaint: ${fromComplaint.affectedRows || 0}`,
    );

    // Backfill from trailing flute code in Size (A/AB/B/BC/C/E)
    const [missing] = await conn.query(`
      SELECT id, size FROM reject_records
      WHERE flute_id IS NULL
        AND size IS NOT NULL
        AND TRIM(size) <> ''
    `);
    let fromSize = 0;
    for (const row of missing) {
      const code = parseFluteFromSize(row.size);
      if (!code) continue;
      const [flutes] = await conn.query(
        `SELECT id FROM flutes WHERE UPPER(name) = ? LIMIT 1`,
        [code],
      );
      if (!flutes[0]) continue;
      await conn.query(`UPDATE reject_records SET flute_id = ? WHERE id = ?`, [
        flutes[0].id,
        row.id,
      ]);
      fromSize += 1;
    }
    console.log(`Backfilled flute_id from size: ${fromSize}`);
    console.log("Reject flute field ready");
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
