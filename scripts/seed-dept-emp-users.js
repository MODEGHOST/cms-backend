/**
 * Seed CS / QC / QA / PD / CRM users.
 * Login = รหัสพนักงาน (stored in Center_user_lfb.username).
 * Safe to re-run (upserts by username).
 */
import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { createUserRepository } from "../src/repositories/users.js";

const PASSWORD = "Test1234!";

/** @type {{ empId: string, firstName: string, lastName: string, department: string, email: string }[]} */
const USERS = [
  {
    empId: "25010001",
    firstName: "สมชาย",
    lastName: "ใจดี",
    department: "MKT",
    email: "cs.25010001@lee-fibreboard.local",
  },
  {
    empId: "25010002",
    firstName: "สมหญิง",
    lastName: "ตรวจสอบ",
    department: "QC",
    email: "qc.25010002@lee-fibreboard.local",
  },
  {
    empId: "25010003",
    firstName: "วิชัย",
    lastName: "คุณภาพ",
    department: "QA",
    email: "qa.25010003@lee-fibreboard.local",
  },
  {
    empId: "25010004",
    firstName: "ประเสริฐ",
    lastName: "ผลิตดี",
    department: "PD",
    email: "pd.25010004@lee-fibreboard.local",
  },
  {
    empId: "25010005",
    firstName: "นภัสสร",
    lastName: "ลูกค้าสัมพันธ์",
    department: "MKT",
    email: "crm.25010005@lee-fibreboard.local",
  },
];

async function main() {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    for (const name of ["CS", "QC", "QA", "PD", "CRM", "Customer Service"]) {
      await pool.query(
        `INSERT INTO departments (name, is_active) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [name],
      );
    }

    // Keep cms.users in sync with employee-id login for the two remaining center users.
    await pool.query(
      `UPDATE users SET username = '24690054' WHERE id = 1 AND username <> '24690054'`,
    );
    await pool.query(
      `UPDATE users SET username = '24570241' WHERE id = 2 AND username <> '24570241'`,
    );

    const users = createUserRepository(pool);
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    console.log("Creating department users (employee ID login):\n");
    for (const u of USERS) {
      const id = await users.create({
        username: u.empId,
        passwordHash,
        displayName: `${u.firstName} ${u.lastName}`,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        role: "staff",
        department: u.department,
      });
      console.log(
        `  [${u.department}] ${u.empId}  ${u.firstName} ${u.lastName}  (id=${id})`,
      );
    }

    console.log(`\nPassword for all: ${PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
