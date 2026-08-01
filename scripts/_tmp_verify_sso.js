import "../src/core/load-env.js";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { createUserRepository } from "../src/repositories/users.js";

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
});

const users = createUserRepository(pool);
const checks = [
  ["admin", "Admin123!"],
  ["qc", "Qc123!"],
  ["cs_test", "Test1234!"],
  ["toni.admin", null],
  ["peerapon.it", null],
];

const [shared] = await pool.query(
  `SELECT id, username, email, department, status FROM \`${config.sharedDbName}\`.users ORDER BY id`,
);
const [memberships] = await pool.query(
  `SELECT m.user_id, p.username, m.role, p.department, p.display_name
   FROM cms_memberships m
   JOIN users p ON p.id = m.user_id
   ORDER BY m.user_id`,
);
console.log("shared users", shared);
console.log("cms memberships", memberships);

for (const [username, password] of checks) {
  const user = await users.findByUsername(username);
  let passwordOk = null;
  if (password && user?.password_hash) {
    passwordOk = await bcrypt.compare(password, user.password_hash);
  }
  console.log({
    username,
    found: Boolean(user),
    id: user?.id,
    role: user?.role,
    department: user?.department,
    is_active: user?.is_active,
    shared_status: user?.shared_status,
    passwordOk,
  });
}

await pool.end();
