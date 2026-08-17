/**
 * Ensure complaint_records has document deadline tracking columns.
 * Clock starts when CS/QA set document_accepted = P (รับเอกสาร).
 */
export async function ensureDocumentDeadlineColumns(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'complaint_records'
       AND COLUMN_NAME IN ('document_accepted_at', 'document_deadline_warned_on')`,
  );
  const have = new Set(cols.map((c) => c.COLUMN_NAME));

  if (!have.has("document_accepted_at")) {
    await conn.query(`
      ALTER TABLE complaint_records
        ADD COLUMN document_accepted_at DATETIME NULL AFTER document_accepted
    `);
  }
  if (!have.has("document_deadline_warned_on")) {
    await conn.query(`
      ALTER TABLE complaint_records
        ADD COLUMN document_deadline_warned_on DATE NULL AFTER document_accepted_at
    `);
  }
}
