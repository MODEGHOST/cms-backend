/** Add problems.image_file for master problem reference photos. Safe to re-run. */
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

export async function ensureProblemImage(conn) {
  if (!(await columnExists(conn, "problems", "image_file"))) {
    await conn.query(`
      ALTER TABLE problems
        ADD COLUMN image_file VARCHAR(255) NULL AFTER name_en
    `);
  }
}
