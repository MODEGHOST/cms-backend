import { config } from "../core/config.js";
import { hasPermission, isCmsAdmin } from "../core/authz.js";
import { canonicalizeDepartmentName } from "../utils/department-map.js";
import { mergeStaffPermissions } from "../utils/department-permissions.js";
import { createTtlCache } from "../utils/ttl-cache.js";

const authHydrateCache =
  Number(config.authUserCacheTtlSec || 0) > 0
    ? createTtlCache({
        ttlMs: Number(config.authUserCacheTtlSec) * 1000,
        maxEntries: 256,
      })
    : null;

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
  staff: 50,
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
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    email: row.email || null,
    telegram_id: row.telegram_id || null,
    telegram_chat_id: row.telegram_chat_id || null,
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

  function invalidateCache(userId) {
    if (!authHydrateCache || userId == null) return;
    authHydrateCache.del(`id:${Number(userId)}`);
  }

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
    const { roles, permissions: rolePermissions } =
      await loadRolesAndPermissions(row.id);
    const permissions = mergeStaffPermissions(
      roles,
      rolePermissions,
      row.department,
    );
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
      c.email,
      c.telegram_id,
      c.telegram_chat_id,
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

  async function loadById(id) {
    const [rows] = await pool.query(
      `${baseSelect}
       WHERE c.id = ?
       LIMIT 1`,
      [id],
    );
    return hydrate(rows[0]);
  }

  return {
    invalidateCache,

    async findByUsername(username) {
      const [rows] = await pool.query(
        `${baseSelect}
         WHERE c.username = ?
         LIMIT 1`,
        [username],
      );
      const user = await hydrate(rows[0]);
      // Login must see fresh membership/roles — bust any stale cache entry.
      if (user?.id) invalidateCache(user.id);
      return user;
    },

    async findById(id) {
      if (!authHydrateCache) return loadById(id);
      return authHydrateCache.getOrSet(`id:${Number(id)}`, () => loadById(id));
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
      invalidateCache(userId);
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
      invalidateCache(userId);
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

      // Access-level roles only; workflow comes from department at hydrate.
      const allowed = new Set(["developer", "admin", "staff", "viewer"]);
      let roleName = String(role || "viewer").trim();
      if (roleName === "cs" || roleName === "qa" || roleName === "qc" || roleName === "department") {
        roleName = "staff";
      }
      if (!allowed.has(roleName)) roleName = "staff";
      const cleanDepartment = canonicalizeDepartmentName(department);

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
            cleanDepartment,
          ],
        );
        centerId = Number(result.insertId);
      } else if (passwordHash) {
        await pool.query(
          `UPDATE ${center}
           SET password_hash = ?, department = COALESCE(?, department)
           WHERE id = ?`,
          [passwordHash, cleanDepartment, centerId],
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
        [centerId, cleanUsername, cleanDisplay, cleanDepartment],
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
      invalidateCache(id);
    },

    /**
     * Find active members whose department is in `departmentNames`.
     * When `matchDepartmentId` is set, also require that department id.
     */
    async findByDepartments(departmentNames, matchDepartmentId = null) {
      const names = (departmentNames || [])
        .map((n) => canonicalizeDepartmentName(n))
        .filter(Boolean);
      if (!names.length && !matchDepartmentId) return [];

      if (matchDepartmentId) {
        const [rows] = await pool.query(
          `SELECT DISTINCT u.id, u.username, u.department,
                  COALESCE(cu.telegram_chat_id, cu.telegram_id) AS telegram_id
           FROM users u
           JOIN cms_memberships m ON m.user_id = u.id AND COALESCE(m.is_active, 1) = 1
           LEFT JOIN ${center} cu ON cu.id = u.id
           WHERE u.is_active = 1
             AND u.department = (SELECT name FROM departments WHERE id = ?)`,
          [matchDepartmentId],
        );
        return rows;
      }

      const [rows] = await pool.query(
        `SELECT DISTINCT u.id, u.username, u.department,
                COALESCE(cu.telegram_chat_id, cu.telegram_id) AS telegram_id
         FROM users u
         JOIN cms_memberships m ON m.user_id = u.id AND COALESCE(m.is_active, 1) = 1
         LEFT JOIN ${center} cu ON cu.id = u.id
         WHERE u.is_active = 1 AND u.department IN (?)`,
        [names],
      );
      return rows;
    },

    /** @deprecated use findByDepartments — kept for older call sites during transition */
    async findByRolesAndDepartment(roleNames, departmentId) {
      const legacyToDepts = {
        cs: ["MKT", "SALE"],
        qa: ["QA"],
        qc: ["QC"],
        department: [],
      };
      const depts = [];
      for (const role of roleNames || []) {
        const mapped = legacyToDepts[role];
        if (mapped) depts.push(...mapped);
      }
      if ((roleNames || []).includes("department") && departmentId) {
        return this.findByDepartments([], departmentId);
      }
      return this.findByDepartments([...new Set(depts)], null);
    },

    hasPermission,
    isCmsAdmin,
  };
}
