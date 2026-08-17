/**
 * Editable Target % for DeptTargetRateTable (reject / complaint).
 * Defaults live in DEPT_TARGET_ROWS; overrides persist here.
 */
export async function ensureDeptTargetSettings(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS dept_target_settings (
      kind ENUM('reject', 'complaint') NOT NULL,
      row_key VARCHAR(64) NOT NULL,
      target_pct DECIMAL(10, 4) NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (kind, row_key)
    ) ENGINE=InnoDB
  `);
}
