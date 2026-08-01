const ROLES = [
  {
    name: "developer",
    label: "Developer",
    description: "ทีมพัฒนาระบบ — จัดการทุกอย่างใน CMS",
  },
  { name: "admin", label: "ผู้ดูแลระบบ", description: "สิทธิ์เต็มใน CMS" },
  { name: "cs", label: "CS", description: "งาน Complaint ขั้น CS" },
  { name: "qa", label: "QA", description: "งาน Complaint ขั้น QA" },
  { name: "qc", label: "QC", description: "แก้ Reject + ขั้น QA ของ Complaint" },
  {
    name: "department",
    label: "หน่วยงาน",
    description: "รับเรื่อง/กรอกตามหน่วยงานที่รับผิดชอบ",
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
  cs: [
    "rejects.read",
    "complaints.read",
    "complaints.cs",
    "masters.read",
    "dashboard.read",
    "activity.read",
  ],
  qa: [
    "rejects.read",
    "complaints.read",
    "complaints.qa",
    "masters.read",
    "dashboard.read",
    "activity.read",
  ],
  qc: [
    "rejects.read",
    "rejects.update",
    "complaints.read",
    "complaints.qa",
    "masters.read",
    "dashboard.read",
    "activity.read",
  ],
  department: [
    "rejects.read",
    "complaints.read",
    "complaints.department",
    "masters.read",
    "dashboard.read",
    "activity.read",
  ],
  viewer: [
    "rejects.read",
    "complaints.read",
    "masters.read",
    "dashboard.read",
    "activity.read",
  ],
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

  const [roleRows] = await conn.query(`SELECT id, name FROM cms_roles`);
  const [permRows] = await conn.query(`SELECT id, code FROM cms_permissions`);
  const roleIdByName = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));
  const permIdByCode = Object.fromEntries(permRows.map((p) => [p.code, p.id]));

  for (const [roleName, codes] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleIdByName[roleName];
    for (const code of codes) {
      const permissionId = permIdByCode[code];
      if (!roleId || !permissionId) continue;
      await conn.query(
        `INSERT IGNORE INTO cms_role_permissions (role_id, permission_id)
         VALUES (?, ?)`,
        [roleId, permissionId],
      );
    }
  }

  return {
    roles: roleRows.length,
    permissions: permRows.length,
    had_legacy_role_column: hadLegacyRole,
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
