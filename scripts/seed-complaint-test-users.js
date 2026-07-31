import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

const PASSWORD = "Test1234!";
const USERS = [
  {
    username: "cs_test",
    displayName: "ทดสอบ CS",
    department: "CS",
  },
  {
    username: "qa_test",
    displayName: "ทดสอบ QA",
    department: "QA",
  },
  {
    username: "pd_test",
    displayName: "ทดสอบ PD",
    department: "PD",
  },
  {
    username: "lts_test",
    displayName: "ทดสอบ LTS",
    department: "LTS",
  },
  {
    username: "production_test",
    displayName: "ทดสอบ Production",
    department: "Production",
  },
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
    for (const name of ["PD", "LTS", "CS", "QA", "Production", "Customer Service"]) {
      await conn.query(
        `INSERT INTO departments (name, is_active) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [name],
      );
    }

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    for (const user of USERS) {
      await conn.query(
        `INSERT INTO users
           (username, password_hash, display_name, role, department, is_active)
         VALUES (?, ?, ?, 'staff', ?, 1)
         ON DUPLICATE KEY UPDATE
           password_hash = VALUES(password_hash),
           display_name = VALUES(display_name),
           role = 'staff',
           department = VALUES(department),
           is_active = 1`,
        [user.username, passwordHash, user.displayName, user.department],
      );
    }
    console.log("Complaint test users ready:");
    for (const user of USERS) {
      console.log(`  ${user.username} / ${PASSWORD}  (${user.department})`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
