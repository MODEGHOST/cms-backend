/**
 * Delete inactive legacy departments that are no longer referenced.
 * Safe after migrate-departments-master.js remapped FKs.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

const LEGACY_NAMES = [
  "CRM",
  "CS",
  "Customer Service",
  "EN",
  "Packing",
  "Production",
  "ตลาด",
  "ผลิต_QC",
  "วางแผน",
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
    await conn.beginTransaction();

    const [deps] = await conn.query(
      `SELECT id, name, is_active FROM departments
       WHERE name IN (?)`,
      [LEGACY_NAMES],
    );

    const deleted = [];
    const skipped = [];

    for (const dep of deps) {
      const [[{ reject_c }]] = await conn.query(
        `SELECT COUNT(*) AS reject_c FROM reject_records WHERE department_id = ?`,
        [dep.id],
      );
      const [[{ resp_c }]] = await conn.query(
        `SELECT COUNT(*) AS resp_c FROM complaint_records WHERE responsible_department_id = ?`,
        [dep.id],
      );
      const [[{ report_c }]] = await conn.query(
        `SELECT COUNT(*) AS report_c FROM complaint_records WHERE reported_by_department_id = ?`,
        [dep.id],
      );

      const refs = Number(reject_c) + Number(resp_c) + Number(report_c);
      if (refs > 0) {
        skipped.push({ id: dep.id, name: dep.name, refs });
        // Keep hidden from dropdowns
        await conn.query(
          `UPDATE departments SET is_active = 0 WHERE id = ?`,
          [dep.id],
        );
        continue;
      }

      await conn.query(`DELETE FROM departments WHERE id = ?`, [dep.id]);
      deleted.push({ id: dep.id, name: dep.name });
    }

    await conn.commit();

    const [active] = await conn.query(
      `SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name`,
    );

    console.log(
      JSON.stringify({ deleted, skipped, active_departments: active }, null, 2),
    );
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
