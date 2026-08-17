/**
 * Seed CMS complaint test users into shared identity + cms_memberships.
 */
import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { createUserRepository } from "../src/repositories/users.js";

const PASSWORD = "Test1234!";
const USERS = [
  { username: "cs_test", displayName: "ทดสอบ CS", department: "MKT" },
  { username: "qa_test", displayName: "ทดสอบ QA", department: "QA" },
  { username: "pd_test", displayName: "ทดสอบ PD", department: "PD" },
  { username: "lts_test", displayName: "ทดสอบ LTS", department: "LTS" },
  {
    username: "production_test",
    displayName: "ทดสอบ Production",
    department: "PD",
  },
];

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
    try {
      await ensureMembershipsTable(conn);
      for (const name of ["PD", "LTS", "CS", "QA", "Production", "Customer Service"]) {
        await conn.query(
          `INSERT INTO departments (name, is_active) VALUES (?, 1)
           ON DUPLICATE KEY UPDATE is_active = 1`,
          [name],
        );
      }
    } finally {
      conn.release();
    }

    const users = createUserRepository(pool);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    for (const user of USERS) {
      await users.create({
        username: user.username,
        passwordHash,
        displayName: user.displayName,
        role: "staff",
        department: user.department,
      });
    }

    console.log("Complaint test users ready (shared identity + CMS membership):");
    for (const user of USERS) {
      console.log(`  ${user.username} / ${PASSWORD}  (${user.department})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
