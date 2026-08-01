/**
 * Ensure RBAC catalogs are up to date and set peerapon.it as CMS developer.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { ensureCmsRbac } from "../src/core/ensure-cms-rbac.js";
import { createUserRepository } from "../src/repositories/users.js";

const USERNAME = process.env.GRANT_DEVELOPER_USERNAME || "peerapon.it";

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
      await ensureCmsRbac(conn);
    } finally {
      conn.release();
    }

    const users = createUserRepository(pool);
    const user = await users.findByUsername(USERNAME);
    if (!user) {
      throw new Error(`ไม่พบ ${USERNAME} ใน Center_user_lfb`);
    }

    await users.upsertLocalProfile({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      department: user.department || "Development",
      isActive: true,
    });
    await users.setRoles(user.id, ["developer"]);

    const refreshed = await users.findById(user.id);
    console.log(
      JSON.stringify(
        {
          username: refreshed.username,
          id: refreshed.id,
          roles: refreshed.roles,
          permissions: refreshed.permissions?.length,
          department: refreshed.department,
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
