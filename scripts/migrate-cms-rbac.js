/**
 * Seed CMS RBAC catalogs and migrate legacy cms_memberships.role ENUM
 * into cms_membership_roles. Safe to re-run.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { ensureCmsRbac } from "../src/core/ensure-cms-rbac.js";

function mapLegacyRole({ legacyRole, department }) {
  if (legacyRole === "admin") return "admin";
  const dept = String(department || "").trim().toUpperCase();
  if (dept === "CS" || dept === "CUSTOMER SERVICE") return "cs";
  if (dept === "QA") return "qa";
  if (dept === "QC") return "qc";
  if (dept) return "department";
  return "viewer";
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    const summary = await ensureCmsRbac(conn);

    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'cms_memberships' AND COLUMN_NAME = 'role'`,
      [config.db.database],
    );

    let migrated = 0;
    if (cols.length) {
      const [legacyRows] = await conn.query(
        `SELECT m.user_id, m.role AS legacy_role, p.department
         FROM cms_memberships m
         LEFT JOIN users p ON p.id = m.user_id`,
      );

      const [roles] = await conn.query(`SELECT id, name FROM cms_roles`);
      const roleIdByName = Object.fromEntries(roles.map((r) => [r.name, r.id]));

      for (const row of legacyRows) {
        const roleName = mapLegacyRole({
          legacyRole: row.legacy_role,
          department: row.department,
        });
        const roleId = roleIdByName[roleName];
        if (!roleId) continue;
        await conn.query(
          `INSERT IGNORE INTO cms_membership_roles (user_id, role_id) VALUES (?, ?)`,
          [row.user_id, roleId],
        );
        migrated += 1;
      }

      // Drop legacy ENUM after roles are assigned.
      await conn.query(`ALTER TABLE cms_memberships DROP COLUMN role`);
    } else {
      // Ensure every membership has at least one role.
      const [orphans] = await conn.query(
        `SELECT m.user_id, p.department
         FROM cms_memberships m
         LEFT JOIN users p ON p.id = m.user_id
         LEFT JOIN cms_membership_roles mr ON mr.user_id = m.user_id
         WHERE mr.role_id IS NULL`,
      );
      const [roles] = await conn.query(`SELECT id, name FROM cms_roles`);
      const roleIdByName = Object.fromEntries(roles.map((r) => [r.name, r.id]));
      for (const row of orphans) {
        const roleName = mapLegacyRole({
          legacyRole: "staff",
          department: row.department,
        });
        await conn.query(
          `INSERT IGNORE INTO cms_membership_roles (user_id, role_id) VALUES (?, ?)`,
          [row.user_id, roleIdByName[roleName]],
        );
        migrated += 1;
      }
    }

    const [members] = await conn.query(
      `SELECT m.user_id, p.username, p.department,
              GROUP_CONCAT(r.name ORDER BY r.name) AS roles
       FROM cms_memberships m
       LEFT JOIN users p ON p.id = m.user_id
       LEFT JOIN cms_membership_roles mr ON mr.user_id = m.user_id
       LEFT JOIN cms_roles r ON r.id = mr.role_id
       GROUP BY m.user_id, p.username, p.department
       ORDER BY m.user_id`,
    );

    console.log(
      JSON.stringify(
        {
          ...summary,
          memberships_migrated: migrated,
          members,
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
