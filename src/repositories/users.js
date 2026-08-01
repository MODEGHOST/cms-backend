import { config } from "../core/config.js";
import { hasPermission, isCmsAdmin } from "../core/authz.js";

export function centerUserTableSql(cfg = config) {
  return `\`${cfg.sharedDbName}\`.\`${cfg.centerUserTable}\``;
}

function displayNameFromCenter(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  if (full) return full;
  return row.username;
}

const ROLE_RANK = {
  developer: 110,
  admin: 100,
  qc: 80,
  qa: 70,
  cs: 60,
  department: 40,
  viewer: 10,
};

function pickPrimaryRole(roleNames) {
  if (!roleNames.length) return null;
  return [...roleNames].sort(
    (a, b) => (ROLE_RANK[b] || 0) - (ROLE_RANK[a] || 0),
  )[0];
}

function toAppUser(row, { roles = [], permissions = [] } = {}) {
  if (!row) return null;
  const roleNames = roles.length
    ? roles
    : row.cms_role
      ? [row.cms_role]
      : [];
  return {
    id: Number(row.id),
    username: row.username,
    display_name: row.display_name || displayNameFromCenter(row),
    role: pickPrimaryRole(roleNames) || "viewer",
    roles: roleNames,
    permissions,
    department: row.department || null,
    is_active: Number(row.is_active) === 1,
    password_hash: row.password_hash || null,
    shared_status: row.shared_status || null,
  };
}

/**
 * Identity = shared_auth.Center_user_lfb
 * CMS access = cms_memberships + cms_membership_roles + permissions
 */
export function createUserRepository(pool) {
  const center = centerUserTableSql();

  async function loadRolesAndPermissions(userId) {
    const [roleRows] = await pool.query(
      `SELECT r.name
       FROM cms_membership_roles mr
       JOIN cms_roles r ON r.id = mr.role_id
       WHERE mr.user_id = ?
       ORDER BY r.name`,
      [userId],
    );
    const roles = roleRows.map((r) => r.name);
    const [permRows] = await pool.query(
      `SELECT DISTINCT p.code
       FROM cms_membership_roles mr
       JOIN cms_role_permissions rp ON rp.role_id = mr.role_id
       JOIN cms_permissions p ON p.id = rp.permission_id
       WHERE mr.user_id = ?
       ORDER BY p.code`,
      [userId],
    );
    return {
      roles,
      permissions: permRows.map((p) => p.code),
    };
  }

  async function hydrate(row) {
    if (!row) return null;
    const display_name = row.local_display_name || displayNameFromCenter(row);
    if (!row.membership_user_id) {
      return toAppUser(
        { ...row, display_name, is_active: 0 },
        { roles: [], permissions: [] },
      );
    }
    const { roles, permissions } = await loadRolesAndPermissions(row.id);
    return toAppUser(
      { ...row, display_name },
      { roles, permissions },
    );
  }

  const baseSelect = `
    SELECT
      c.id,
      c.username,
      c.password_hash,
      c.first_name,
      c.last_name,
      c.status AS shared_status,
      COALESCE(p.display_name, NULL) AS local_display_name,
      COALESCE(p.department, c.department) AS department,
      CASE
        WHEN m.user_id IS NOT NULL AND COALESCE(m.is_active, 1) = 1
             AND COALESCE(p.is_active, 1) = 1 THEN 1
        ELSE 0
      END AS is_active,
      m.user_id AS membership_user_id
    FROM ${center} c
    LEFT JOIN users p ON p.id = c.id
    LEFT JOIN cms_memberships m ON m.user_id = c.id
  `;

  return {
    async findByUsername(username) {
      const [rows] = await pool.query(
        `${baseSelect}
         WHERE c.username = ?
         LIMIT 1`,
        [username],
      );
      return hydrate(rows[0]);
    },

    async findById(id) {
      const [rows] = await pool.query(
        `${baseSelect}
         WHERE c.id = ?
         LIMIT 1`,
        [id],
      );
      return hydrate(rows[0]);
    },

    async countMemberships() {
      const [[{ count }]] = await pool.query(
        "SELECT COUNT(*) AS count FROM cms_memberships",
      );
      return Number(count);
    },

    async countAll() {
      return this.countMemberships();
    },

    async assignRole(userId, roleName) {
      const [[role]] = await pool.query(
        `SELECT id FROM cms_roles WHERE name = ? LIMIT 1`,
        [roleName],
      );
      if (!role) {
        throw new Error(`Unknown CMS role: ${roleName}`);
      }
      await pool.query(
        `INSERT INTO cms_memberships (user_id, is_active)
         VALUES (?, 1)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [userId],
      );
      await pool.query(
        `INSERT IGNORE INTO cms_membership_roles (user_id, role_id)
         VALUES (?, ?)`,
        [userId, role.id],
      );
    },

    async setRoles(userId, roleNames = []) {
      await pool.query(
        `INSERT INTO cms_memberships (user_id, is_active)
         VALUES (?, 1)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [userId],
      );
      await pool.query(`DELETE FROM cms_membership_roles WHERE user_id = ?`, [
        userId,
      ]);
      for (const roleName of roleNames) {
        await this.assignRole(userId, roleName);
      }
    },

    /**
     * Create center identity (if needed) + CMS profile + membership role.
     */
    async create({
      username,
      passwordHash,
      displayName,
      role = "viewer",
      department = null,
      email = null,
      firstName = null,
      lastName = null,
      telegramId = null,
    }) {
      const cleanUsername = String(username || "").trim();
      const cleanDisplay = String(displayName || cleanUsername).trim();
      const parts = cleanDisplay.split(/\s+/).filter(Boolean);
      const fn = firstName || parts[0] || cleanUsername;
      const ln = lastName || parts.slice(1).join(" ") || "-";
      const cleanEmail =
        email || `${cleanUsername.toLowerCase()}@cms.local`;

      // Map legacy admin/staff to RBAC role names.
      let roleName = role;
      if (role === "staff") {
        const dept = String(department || "").trim().toUpperCase();
        if (dept === "CS" || dept === "CUSTOMER SERVICE") roleName = "cs";
        else if (dept === "QA") roleName = "qa";
        else if (dept === "QC") roleName = "qc";
        else if (dept) roleName = "department";
        else roleName = "viewer";
      }

      const [[existing]] = await pool.query(
        `SELECT id FROM ${center} WHERE username = ? LIMIT 1`,
        [cleanUsername],
      );

      let centerId = existing ? Number(existing.id) : null;
      if (!centerId) {
        const [result] = await pool.query(
          `INSERT INTO ${center}
             (first_name, last_name, email, username, telegram_id, password_hash,
              department, status, token_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)`,
          [
            fn,
            ln,
            cleanEmail,
            cleanUsername,
            telegramId || null,
            passwordHash,
            department,
          ],
        );
        centerId = Number(result.insertId);
      } else if (passwordHash) {
        await pool.query(
          `UPDATE ${center}
           SET password_hash = ?, department = COALESCE(?, department)
           WHERE id = ?`,
          [passwordHash, department, centerId],
        );
      }

      await pool.query(
        `INSERT INTO users
           (id, username, password_hash, display_name, role, department, is_active)
         VALUES (?, ?, '', ?, 'staff', ?, 1)
         ON DUPLICATE KEY UPDATE
           username = VALUES(username),
           display_name = VALUES(display_name),
           department = VALUES(department),
           is_active = 1`,
        [centerId, cleanUsername, cleanDisplay, department],
      );

      await this.setRoles(centerId, [roleName]);
      return centerId;
    },

    async upsertLocalProfile({
      id,
      username,
      displayName,
      department = null,
      isActive = true,
    }) {
      await pool.query(
        `INSERT INTO users
           (id, username, password_hash, display_name, role, department, is_active)
         VALUES (?, ?, '', ?, 'staff', ?, ?)
         ON DUPLICATE KEY UPDATE
           username = VALUES(username),
           display_name = VALUES(display_name),
           department = COALESCE(VALUES(department), department),
           is_active = VALUES(is_active)`,
        [
          id,
          username,
          displayName,
          department,
          isActive ? 1 : 0,
        ],
      );
    },

    hasPermission,
    isCmsAdmin,
  };
}
