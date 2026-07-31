/**
 * Ensure users.department column exists and seed a QC staff user.
 * Safe to re-run.
 */
import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

async function ensureDepartmentColumn(conn) {
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'department'`,
    [config.db.database],
  );
  if (cols.length) return false;

  await conn.query(`
    ALTER TABLE users
      ADD COLUMN department VARCHAR(80) NULL AFTER role,
      ADD KEY idx_users_department (department)
  `);
  return true;
}

async function ensureQcUser(conn) {
  const [[existing]] = await conn.query(
    `SELECT id, username, department FROM users WHERE username = ? LIMIT 1`,
    ["qc"],
  );
  if (existing) {
    if (!existing.department) {
      await conn.query(`UPDATE users SET department = 'QC' WHERE id = ?`, [existing.id]);
    }
    return { created: false, id: existing.id };
  }

  const passwordHash = await bcrypt.hash("Qc123!", 10);
  const [result] = await conn.query(
    `INSERT INTO users (username, password_hash, display_name, role, department, is_active)
     VALUES (?, ?, ?, 'staff', 'QC', 1)`,
    ["qc", passwordHash, "เจ้าหน้าที่ QC"],
  );
  return { created: true, id: result.insertId };
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
    const addedColumn = await ensureDepartmentColumn(conn);
    const qc = await ensureQcUser(conn);
    const [rows] = await conn.query(
      `SELECT id, username, display_name, role, department, is_active
       FROM users
       ORDER BY id ASC`,
    );
    console.log(
      JSON.stringify(
        {
          department_column_added: addedColumn,
          qc_user: qc,
          users: rows,
        },
        null,
        2,
      ),
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
