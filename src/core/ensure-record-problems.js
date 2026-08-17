/**
 * Junction tables so Complaint / Reject can store more than one ปัญหา.
 * Safe to re-run. Backfills from existing problem_id.
 */
async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

export async function ensureRecordProblems(conn) {
  if (await tableExists(conn, "complaint_records")) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS complaint_record_problems (
        complaint_id BIGINT UNSIGNED NOT NULL,
        problem_id BIGINT UNSIGNED NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (complaint_id, problem_id),
        KEY idx_crp_problem (problem_id),
        CONSTRAINT fk_crp_complaint
          FOREIGN KEY (complaint_id) REFERENCES complaint_records (id)
          ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT fk_crp_problem
          FOREIGN KEY (problem_id) REFERENCES problems (id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      INSERT IGNORE INTO complaint_record_problems (complaint_id, problem_id, sort_order)
      SELECT id, problem_id, 0
        FROM complaint_records
       WHERE problem_id IS NOT NULL
    `);

    if (!(await columnExists(conn, "complaint_records", "problem_names_json"))) {
      await conn.query(`
        ALTER TABLE complaint_records
          ADD COLUMN problem_names_json TEXT NULL AFTER problem_id
      `);
    }
  }

  if (await tableExists(conn, "reject_records")) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS reject_record_problems (
        reject_id BIGINT UNSIGNED NOT NULL,
        problem_id BIGINT UNSIGNED NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (reject_id, problem_id),
        KEY idx_rrp_problem (problem_id),
        CONSTRAINT fk_rrp_reject
          FOREIGN KEY (reject_id) REFERENCES reject_records (id)
          ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT fk_rrp_problem
          FOREIGN KEY (problem_id) REFERENCES problems (id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      INSERT IGNORE INTO reject_record_problems (reject_id, problem_id, sort_order)
      SELECT id, problem_id, 0
        FROM reject_records
       WHERE problem_id IS NOT NULL
    `);

    if (!(await columnExists(conn, "reject_records", "problem_names_json"))) {
      await conn.query(`
        ALTER TABLE reject_records
          ADD COLUMN problem_names_json TEXT NULL AFTER problem_id
      `);
    }
  }
}
