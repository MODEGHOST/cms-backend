/**
 * Ensure RBAC tables + seed catalogs exist.
 * Role = access level (developer / admin / staff / viewer).
 * Workflow permissions for staff come from department at hydrate time.
 * Migrates legacy workflow roles (cs / qa / qc / department) → staff + department.
 */
import { canonicalizeDepartmentName } from "../utils/department-map.js";
import {
  LEGACY_WORKFLOW_ROLES,
  STAFF_BASE_PERMISSIONS,
  pickDefaultDepartmentFromLegacyRoles,
} from "../utils/department-permissions.js";

const ROLES = [
  {
    name: "developer",
    label: "Developer",
    description: "ทีมพัฒนาระบบ — จัดการทุกอย่างใน CMS",
  },
  { name: "admin", label: "ผู้ดูแลระบบ", description: "สิทธิ์เต็มใน CMS" },
  {
    name: "staff",
    label: "พนักงาน",
    description: "พนักงานทั่วไป — สิทธิ์งานขึ้นกับแผนกที่สังกัด",
  },
  { name: "viewer", label: "ผู้ดูอย่างเดียว", description: "อ่านข้อมูลได้อย่างเดียว" },
];

const PERMISSIONS = [
  { code: "rejects.read", description: "ดูรายการ Reject" },
  { code: "rejects.update", description: "แก้ไข Reject (QC)" },
  { code: "complaints.read", description: "ดูรายการ Complaint" },
  { code: "complaints.cs", description: "ทำงานขั้น CS ใน Complaint" },
  { code: "complaints.qa", description: "ทำงานขั้น QA ใน Complaint" },
  {
    code: "complaints.department",
    description: "รับเรื่อง/กรอกข้อมูลหน่วยงานที่รับผิดชอบ",
  },
  {
    code: "complaints.manage_all",
    description: "ข้ามข้อจำกัดแผนกใน Complaint (แอดมิน)",
  },
  { code: "masters.read", description: "ดูข้อมูล Master" },
  { code: "masters.manage", description: "สร้าง/แก้ไข Master" },
  { code: "dashboard.read", description: "ดู Dashboard" },
  { code: "activity.read", description: "ดู Activity log" },
  { code: "members.manage", description: "จัดการสมาชิกและสิทธิ์ CMS" },
  { code: "system.manage", description: "เข้าเมนูจัดการระบบ" },
];

const ALL_CODES = PERMISSIONS.map((p) => p.code);

const ROLE_PERMISSIONS = {
  developer: ALL_CODES,
  admin: ALL_CODES,
  staff: [...STAFF_BASE_PERMISSIONS],
  viewer: [...STAFF_BASE_PERMISSIONS],
};

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `SELECT 1 AS ok
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
     LIMIT 1`,
    [table],
  );
  return rows.length > 0;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 AS ok
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [table, column],
  );
  return rows.length > 0;
}

/**
 * Move members off legacy workflow roles onto staff + department defaults.
 * Idempotent — safe on every boot.
 */
async function migrateLegacyWorkflowRoles(conn, roleIdByName) {
  if (!roleIdByName.staff) {
    return { migrated_users: 0, removed_legacy_roles: 0 };
  }

  const [legacyRoleRows] = await conn.query(
    `SELECT id, name FROM cms_roles WHERE name IN (?)`,
    [LEGACY_WORKFLOW_ROLES],
  );
  if (!legacyRoleRows.length) {
    return { migrated_users: 0, removed_legacy_roles: 0 };
  }
  const legacyIds = legacyRoleRows.map((r) => r.id);

  const [affected] = await conn.query(
    `SELECT DISTINCT user_id
     FROM cms_membership_roles
     WHERE role_id IN (${legacyIds.map(() => "?").join(",")})`,
    legacyIds,
  );

  let migratedUsers = 0;
  for (const { user_id: userId } of affected) {
    const [roleRows] = await conn.query(
      `SELECT r.name
       FROM cms_membership_roles mr
       JOIN cms_roles r ON r.id = mr.role_id
       WHERE mr.user_id = ?`,
      [userId],
    );
    const roleNames = roleRows.map((r) => r.name);
    const legacyHeld = roleNames.filter((n) =>
      LEGACY_WORKFLOW_ROLES.includes(n),
    );
    if (!legacyHeld.length) continue;

    const [[profile]] = await conn.query(
      `SELECT id, department FROM users WHERE id = ? LIMIT 1`,
      [userId],
    );
    const existingDept = canonicalizeDepartmentName(profile?.department);
    const department =
      existingDept || pickDefaultDepartmentFromLegacyRoles(legacyHeld);

    if (profile && department && !existingDept) {
      await conn.query(`UPDATE users SET department = ? WHERE id = ?`, [
        department,
        userId,
      ]);
    }

    const keepRoles = roleNames.filter(
      (n) => !LEGACY_WORKFLOW_ROLES.includes(n),
    );
    const hasElevated = keepRoles.some(
      (n) => n === "developer" || n === "admin",
    );

    let nextRoles = [...keepRoles];
    if (!hasElevated) {
      nextRoles = nextRoles.filter((n) => n !== "viewer");
      if (!nextRoles.includes("staff")) nextRoles.push("staff");
    }

    await conn.query(`DELETE FROM cms_membership_roles WHERE user_id = ?`, [
      userId,
    ]);
    for (const name of [...new Set(nextRoles)]) {
      const roleId = roleIdByName[name];
      if (!roleId) continue;
      await conn.query(
        `INSERT IGNORE INTO cms_membership_roles (user_id, role_id) VALUES (?, ?)`,
        [userId, roleId],
      );
    }
    migratedUsers += 1;
  }

  let removed = 0;
  for (const legacy of legacyRoleRows) {
    const [[{ used }]] = await conn.query(
      `SELECT COUNT(*) AS used FROM cms_membership_roles WHERE role_id = ?`,
      [legacy.id],
    );
    if (Number(used) === 0) {
      await conn.query(`DELETE FROM cms_role_permissions WHERE role_id = ?`, [
        legacy.id,
      ]);
      await conn.query(`DELETE FROM cms_roles WHERE id = ?`, [legacy.id]);
      removed += 1;
    }
  }

  return { migrated_users: migratedUsers, removed_legacy_roles: removed };
}

/**
 * Ensure RBAC tables + seed catalogs exist.
 * Handles upgrade from legacy cms_memberships(user_id, role ENUM).
 */
export async function ensureCmsRbac(conn) {
  const hadLegacyMemberships = await tableExists(conn, "cms_memberships");
  const hadLegacyRole = hadLegacyMemberships
    ? await columnExists(conn, "cms_memberships", "role")
    : false;

  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_roles (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(64) NOT NULL,
      label VARCHAR(120) NOT NULL,
      description VARCHAR(255) NULL,
      is_system TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_cms_roles_name (name)
    ) ENGINE=InnoDB
  `);

  if (!(await columnExists(conn, "cms_roles", "is_system"))) {
    await conn.query(`
      ALTER TABLE cms_roles
        ADD COLUMN is_system TINYINT(1) NOT NULL DEFAULT 1 AFTER description
    `);
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_permissions (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(100) NOT NULL,
      description VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_cms_permissions_code (code)
    ) ENGINE=InnoDB
  `);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_role_permissions (
      role_id INT UNSIGNED NOT NULL,
      permission_id INT UNSIGNED NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      CONSTRAINT fk_cms_rp_role
        FOREIGN KEY (role_id) REFERENCES cms_roles (id) ON DELETE CASCADE,
      CONSTRAINT fk_cms_rp_permission
        FOREIGN KEY (permission_id) REFERENCES cms_permissions (id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  if (!hadLegacyMemberships) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cms_memberships (
        user_id BIGINT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id),
        CONSTRAINT fk_cms_memberships_user
          FOREIGN KEY (user_id) REFERENCES users (id)
          ON UPDATE CASCADE ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);
  } else if (!(await columnExists(conn, "cms_memberships", "is_active"))) {
    await conn.query(`
      ALTER TABLE cms_memberships
        ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1
        AFTER user_id
    `);
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_membership_roles (
      user_id BIGINT UNSIGNED NOT NULL,
      role_id INT UNSIGNED NOT NULL,
      assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, role_id),
      CONSTRAINT fk_cms_mr_user
        FOREIGN KEY (user_id) REFERENCES cms_memberships (user_id) ON DELETE CASCADE,
      CONSTRAINT fk_cms_mr_role
        FOREIGN KEY (role_id) REFERENCES cms_roles (id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);

  for (const role of ROLES) {
    await conn.query(
      `INSERT INTO cms_roles (name, label, description, is_system)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         label = VALUES(label),
         description = VALUES(description),
         is_system = 1`,
      [role.name, role.label, role.description],
    );
  }

  for (const permission of PERMISSIONS) {
    await conn.query(
      `INSERT INTO cms_permissions (code, description)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE description = VALUES(description)`,
      [permission.code, permission.description],
    );
  }

  let [roleRows] = await conn.query(`SELECT id, name FROM cms_roles`);
  const [permRows] = await conn.query(`SELECT id, code FROM cms_permissions`);
  let roleIdByName = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));
  const permIdByCode = Object.fromEntries(permRows.map((p) => [p.code, p.id]));

  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByName[roleName];
    if (!roleId) continue;
    const keepIds = codes
      .map((code) => permIdByCode[code])
      .filter(Boolean);
    for (const permissionId of keepIds) {
      await conn.query(
        `INSERT IGNORE INTO cms_role_permissions (role_id, permission_id)
         VALUES (?, ?)`,
        [roleId, permissionId],
      );
    }
    if (keepIds.length) {
      await conn.query(
        `DELETE FROM cms_role_permissions
         WHERE role_id = ?
           AND permission_id NOT IN (${keepIds.map(() => "?").join(",")})`,
        [roleId, ...keepIds],
      );
    } else {
      await conn.query(
        `DELETE FROM cms_role_permissions WHERE role_id = ?`,
        [roleId],
      );
    }
  }

  const migration = await migrateLegacyWorkflowRoles(conn, roleIdByName);

  [roleRows] = await conn.query(`SELECT id, name FROM cms_roles`);
  roleIdByName = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));

  return {
    roles: roleRows.length,
    permissions: permRows.length,
    had_legacy_role_column: hadLegacyRole,
    ...migration,
  };
}

export { ROLES, PERMISSIONS, ROLE_PERMISSIONS };

/** Permissions that must not be granted to custom CMS roles. */
export const CMS_HIERARCHY_PERMISSIONS = new Set([
  "system.manage",
  "members.manage",
  "complaints.manage_all",
]);

export function isCmsHierarchyPermission(code) {
  return CMS_HIERARCHY_PERMISSIONS.has(String(code || ""));
}
