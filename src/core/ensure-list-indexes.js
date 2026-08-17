/**
 * Indexes for list/inbox/dashboard filters. Safe to re-run.
 */
async function indexExists(conn, table, indexName) {
  const [rows] = await conn.query(
    `SELECT 1
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [table, indexName],
  );
  return rows.length > 0;
}

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

const INDEXES = [
  ["reject_records", "idx_reject_pdr", "pdr_no"],
  ["reject_records", "idx_reject_created", "created_at"],
  ["reject_records", "idx_reject_job_type", "job_type"],
  ["reject_records", "idx_reject_received_date", "reject_received_date"],
  ["complaint_records", "idx_complaint_workflow", "workflow_status"],
  ["complaint_records", "idx_complaint_received_workflow", "received_date, workflow_status"],
];

export async function ensureListIndexes(conn) {
  for (const [table, name, columns] of INDEXES) {
    if (!(await tableExists(conn, table))) continue;
    if (await indexExists(conn, table, name)) continue;
    await conn.query(`ALTER TABLE \`${table}\` ADD KEY \`${name}\` (${columns})`);
  }
}
