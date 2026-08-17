/**
 * Ensure cms_memberships exists and seed a QC staff user via shared identity.
 * Safe to re-run.
 */
import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { createUserRepository } from "../src/repositories/users.js";

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

async function ensureMembershipsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_memberships (
      user_id BIGINT UNSIGNED NOT NULL,
      role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_cms_memberships_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
}

async function main() {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    const conn = await pool.getConnection();
    let addedColumn = false;
    try {
      addedColumn = await ensureDepartmentColumn(conn);
      await ensureMembershipsTable(conn);
    } finally {
      conn.release();
    }

    const users = createUserRepository(pool);
    const existing = await users.findByUsername("qc");
    let qc;
    if (existing?.role) {
      if (!existing.department) {
        await users.upsertLocalProfile({
          id: existing.id,
          username: existing.username,
          displayName: existing.display_name,
          department: "QC",
          isActive: true,
        });
      }
      qc = { created: false, id: existing.id };
    } else {
      const id = await users.create({
        username: "qc",
        passwordHash: await bcrypt.hash("Qc123!", 10),
        displayName: "เจ้าหน้าที่ QC",
        role: "staff",
        department: "QC",
      });
      qc = { created: true, id };
    }

    const [rows] = await pool.query(
      `SELECT p.id, p.username, p.display_name,
              GROUP_CONCAT(r.name ORDER BY r.name) AS roles,
              p.department, p.is_active
       FROM users p
       LEFT JOIN cms_memberships m ON m.user_id = p.id
       LEFT JOIN cms_membership_roles mr ON mr.user_id = p.id
       LEFT JOIN cms_roles r ON r.id = mr.role_id
       GROUP BY p.id, p.username, p.display_name, p.department, p.is_active
       ORDER BY p.id ASC`,
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
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
