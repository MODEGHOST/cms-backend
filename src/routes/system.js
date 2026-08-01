import { randomBytes } from "node:crypto";
import { canManageSystem } from "../core/authz.js";
import {
  isCmsHierarchyPermission,
} from "../core/ensure-cms-rbac.js";
import { httpError } from "../core/http-error.js";
import { centerUserTableSql, createUserRepository } from "../repositories/users.js";

function requireSystemManage(req) {
  if (!canManageSystem(req.user)) {
    throw httpError(403, "ไม่มีสิทธิ์เข้าจัดการระบบ");
  }
}

function slugifyRoleLabel(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "role";
}

export function registerSystemRoutes(app, { pool, wrap, requireAuth }) {
  const users = createUserRepository(pool);
  const center = centerUserTableSql();

  app.get(
    "/api/system/overview",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const [[{ members }]] = await pool.query(
        `SELECT COUNT(*) AS members FROM cms_memberships WHERE is_active = 1`,
      );
      const [[{ roles }]] = await pool.query(
        `SELECT COUNT(*) AS roles FROM cms_roles`,
      );
      const [[{ permissions }]] = await pool.query(
        `SELECT COUNT(*) AS permissions FROM cms_permissions`,
      );
      const [[{ center_users }]] = await pool.query(
        `SELECT COUNT(*) AS center_users FROM ${center}`,
      );
      res.json({
        data: {
          active_members: Number(members),
          roles: Number(roles),
          permissions: Number(permissions),
          center_users: Number(center_users),
          modules: [
            {
              key: "members",
              title: "สมาชิก & สิทธิ์",
              description: "เปิดสิทธิ์เข้า CMS, กำหนด role, แผนก, เปิด/ปิดบัญชี",
            },
            {
              key: "roles",
              title: "บทบาท & Permission",
              description: "ดู Built-in และสร้าง Custom Role ได้",
            },
            {
              key: "masters",
              title: "Master Data",
              description: "บริษัท / แผนก / เครื่อง / ปัญหา — ใช้เมนู Master Data",
              href: "/masters",
            },
            {
              key: "activity",
              title: "Activity Log",
              description: "ประวัติการแก้ไขข้อมูล — ใช้เมนู Activity Log",
              href: "/activity-logs",
            },
          ],
        },
      });
    }),
  );

  app.get(
    "/api/system/roles",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const [roles] = await pool.query(
        `SELECT r.id, r.name, r.label, r.description, r.is_system,
                GROUP_CONCAT(p.code ORDER BY p.code) AS permission_codes
         FROM cms_roles r
         LEFT JOIN cms_role_permissions rp ON rp.role_id = r.id
         LEFT JOIN cms_permissions p ON p.id = rp.permission_id
         GROUP BY r.id, r.name, r.label, r.description, r.is_system
         ORDER BY r.is_system DESC,
                  FIELD(r.name, 'developer','admin','qc','qa','cs','department','viewer'),
                  r.id`,
      );
      res.json({
        data: roles.map((row) => ({
          id: row.id,
          name: row.name,
          label: row.label,
          description: row.description,
          is_system: Number(row.is_system) === 1,
          can_edit_permissions: Number(row.is_system) !== 1,
          can_assign: true,
          permissions: row.permission_codes
            ? String(row.permission_codes).split(",")
            : [],
        })),
      });
    }),
  );

  app.get(
    "/api/system/permissions",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const [rows] = await pool.query(
        `SELECT id, code, description FROM cms_permissions ORDER BY code`,
      );
      res.json({
        data: rows.map((row) => ({
          ...row,
          grantable_to_custom_role: !isCmsHierarchyPermission(row.code),
        })),
      });
    }),
  );

  app.post(
    "/api/system/roles",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const label = String(req.body?.label || req.body?.name || "").trim();
      const description = String(req.body?.description || "").trim() || null;
      if (!label || label.length > 120) {
        throw httpError(400, "ชื่อ Role ไม่ถูกต้อง");
      }
      const base = slugifyRoleLabel(label);
      const name = `custom_${base}_${randomBytes(3).toString("hex")}`;
      try {
        const [result] = await pool.query(
          `INSERT INTO cms_roles (name, label, description, is_system)
           VALUES (?, ?, ?, 0)`,
          [name, label, description],
        );
        res.status(201).json({
          data: {
            id: result.insertId,
            name,
            label,
            description,
            is_system: false,
            can_edit_permissions: true,
            permissions: [],
          },
          message: "สร้าง Custom Role แล้ว",
        });
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
          throw httpError(409, "ชื่อ Role ซ้ำ กรุณาลองใหม่");
        }
        throw error;
      }
    }),
  );

  app.put(
    "/api/system/roles/:roleId/permissions",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const roleId = Number(req.params.roleId);
      if (!Number.isInteger(roleId) || roleId <= 0) {
        throw httpError(400, "roleId ไม่ถูกต้อง");
      }
      const permissionIds = [
        ...new Set(
          (Array.isArray(req.body?.permissionIds) ? req.body.permissionIds : [])
            .map(Number)
            .filter((id) => Number.isInteger(id) && id > 0),
        ),
      ];

      const [[role]] = await pool.query(
        `SELECT id, name, is_system FROM cms_roles WHERE id = ? LIMIT 1`,
        [roleId],
      );
      if (!role) throw httpError(404, "ไม่พบ Role");
      if (Number(role.is_system) === 1) {
        throw httpError(
          403,
          "Built-in Role แก้ไขไม่ได้ กรุณาสร้าง Custom Role",
        );
      }

      let valid = [];
      if (permissionIds.length) {
        const [rows] = await pool.query(
          `SELECT id, code FROM cms_permissions
           WHERE id IN (${permissionIds.map(() => "?").join(",")})`,
          permissionIds,
        );
        valid = rows;
        if (valid.length !== permissionIds.length) {
          throw httpError(400, "พบ Permission ที่ไม่ถูกต้อง");
        }
        const forbidden = valid.filter((p) => isCmsHierarchyPermission(p.code));
        if (forbidden.length) {
          throw httpError(
            403,
            "Custom Role ไม่สามารถรับสิทธิ์จัดการระบบ / สมาชิก / manage_all ได้",
          );
        }
      }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `DELETE FROM cms_role_permissions WHERE role_id = ?`,
          [roleId],
        );
        for (const permission of valid) {
          await conn.query(
            `INSERT INTO cms_role_permissions (role_id, permission_id)
             VALUES (?, ?)`,
            [roleId, permission.id],
          );
        }
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }

      res.json({
        message: "บันทึก Permission แล้ว",
        data: {
          role_id: roleId,
          permissions: valid.map((p) => p.code),
        },
      });
    }),
  );

  app.delete(
    "/api/system/roles/:roleId",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const roleId = Number(req.params.roleId);
      if (!Number.isInteger(roleId) || roleId <= 0) {
        throw httpError(400, "roleId ไม่ถูกต้อง");
      }
      const [[role]] = await pool.query(
        `SELECT id, is_system FROM cms_roles WHERE id = ? LIMIT 1`,
        [roleId],
      );
      if (!role) throw httpError(404, "ไม่พบ Role");
      if (Number(role.is_system) === 1) {
        throw httpError(403, "Built-in Role ลบไม่ได้");
      }
      const [[{ used }]] = await pool.query(
        `SELECT COUNT(*) AS used FROM cms_membership_roles WHERE role_id = ?`,
        [roleId],
      );
      if (Number(used) > 0) {
        throw httpError(
          400,
          "Role นี้ยังถูกมอบหมายอยู่ กรุณาถอดจากสมาชิกก่อน",
        );
      }
      await pool.query(`DELETE FROM cms_roles WHERE id = ?`, [roleId]);
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/system/members",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const q = String(req.query.q || "").trim();
      const params = [];
      let where = "1=1";
      if (q) {
        where += ` AND (c.username LIKE ? OR p.display_name LIKE ? OR c.email LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      const [rows] = await pool.query(
        `SELECT
           c.id,
           c.username,
           c.email,
           c.first_name,
           c.last_name,
           c.status AS center_status,
           COALESCE(p.display_name, CONCAT(c.first_name, ' ', c.last_name)) AS display_name,
           COALESCE(p.department, c.department) AS department,
           m.is_active,
           GROUP_CONCAT(r.name ORDER BY r.name) AS role_names,
           GROUP_CONCAT(r.label ORDER BY r.name) AS role_labels
         FROM cms_memberships m
         JOIN ${center} c ON c.id = m.user_id
         LEFT JOIN users p ON p.id = m.user_id
         LEFT JOIN cms_membership_roles mr ON mr.user_id = m.user_id
         LEFT JOIN cms_roles r ON r.id = mr.role_id
         WHERE ${where}
         GROUP BY c.id, c.username, c.email, c.first_name, c.last_name, c.status,
                  p.display_name, p.department, c.department, m.is_active
         ORDER BY c.username`,
        params,
      );
      res.json({
        data: rows.map((row) => ({
          id: Number(row.id),
          username: row.username,
          email: row.email,
          display_name: row.display_name,
          department: row.department,
          is_active: Number(row.is_active) === 1,
          center_status: row.center_status,
          roles: row.role_names ? String(row.role_names).split(",") : [],
          role_labels: row.role_labels ? String(row.role_labels).split(",") : [],
        })),
      });
    }),
  );

  app.get(
    "/api/system/center-users",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const q = String(req.query.q || "").trim();
      const onlyWithoutMembership = req.query.without_membership !== "0";
      const params = [];
      let where = "c.status <> 'suspended'";
      if (onlyWithoutMembership) {
        where += " AND m.user_id IS NULL";
      }
      if (q) {
        where += ` AND (c.username LIKE ? OR c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      const [rows] = await pool.query(
        `SELECT c.id, c.username, c.email, c.first_name, c.last_name, c.department, c.status,
                m.user_id AS membership_user_id
         FROM ${center} c
         LEFT JOIN cms_memberships m ON m.user_id = c.id
         WHERE ${where}
         ORDER BY c.username
         LIMIT 50`,
        params,
      );
      res.json({
        data: rows.map((row) => ({
          id: Number(row.id),
          username: row.username,
          email: row.email,
          display_name: `${row.first_name || ""} ${row.last_name || ""}`.trim(),
          department: row.department,
          status: row.status,
          has_membership: Boolean(row.membership_user_id),
        })),
      });
    }),
  );

  app.post(
    "/api/system/members",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const userId = Number(req.body?.user_id);
      const roleNames = Array.isArray(req.body?.roles)
        ? req.body.roles.map((r) => String(r).trim()).filter(Boolean)
        : [String(req.body?.role || "viewer").trim()];
      const department =
        req.body?.department === undefined
          ? undefined
          : String(req.body.department || "").trim() || null;

      if (!Number.isInteger(userId) || userId <= 0) {
        throw httpError(400, "user_id ไม่ถูกต้อง");
      }
      if (!roleNames.length) {
        throw httpError(400, "ต้องระบุอย่างน้อย 1 role");
      }

      const [[centerUser]] = await pool.query(
        `SELECT id, username, first_name, last_name, department, status
         FROM ${center} WHERE id = ? LIMIT 1`,
        [userId],
      );
      if (!centerUser || centerUser.status === "suspended") {
        throw httpError(404, "ไม่พบบัญชีใน Center_user_lfb");
      }

      const displayName =
        `${centerUser.first_name || ""} ${centerUser.last_name || ""}`.trim() ||
        centerUser.username;

      await users.upsertLocalProfile({
        id: centerUser.id,
        username: centerUser.username,
        displayName,
        department:
          department !== undefined ? department : centerUser.department,
        isActive: true,
      });
      await users.setRoles(centerUser.id, roleNames);

      const member = await users.findById(centerUser.id);
      res.status(201).json({ data: member && {
        id: member.id,
        username: member.username,
        display_name: member.display_name,
        department: member.department,
        roles: member.roles,
        is_active: member.is_active,
      }});
    }),
  );

  app.patch(
    "/api/system/members/:userId",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw httpError(400, "userId ไม่ถูกต้อง");
      }

      const [[membership]] = await pool.query(
        `SELECT user_id, is_active FROM cms_memberships WHERE user_id = ? LIMIT 1`,
        [userId],
      );
      if (!membership) {
        throw httpError(404, "ยังไม่ใช่สมาชิก CMS");
      }

      if (Array.isArray(req.body?.roles)) {
        const roleNames = req.body.roles
          .map((r) => String(r).trim())
          .filter(Boolean);
        if (!roleNames.length) {
          throw httpError(400, "ต้องระบุอย่างน้อย 1 role");
        }
        // Prevent locking yourself out of system management.
        if (userId === Number(req.user.id) && !roleNames.includes("developer")
            && !roleNames.includes("admin")) {
          throw httpError(
            400,
            "ไม่สามารถถอด role developer/admin ของตัวเองได้",
          );
        }
        await users.setRoles(userId, roleNames);
      }

      if (req.body?.department !== undefined || req.body?.display_name !== undefined
          || req.body?.is_active !== undefined) {
        const [[profile]] = await pool.query(
          `SELECT username, display_name, department, is_active FROM users WHERE id = ?`,
          [userId],
        );
        const [[centerUser]] = await pool.query(
          `SELECT username, first_name, last_name FROM ${center} WHERE id = ?`,
          [userId],
        );
        const nextActive =
          req.body?.is_active === undefined
            ? Number(membership.is_active) === 1
            : Boolean(req.body.is_active);
        if (userId === Number(req.user.id) && !nextActive) {
          throw httpError(400, "ไม่สามารถปิดใช้งานบัญชีของตัวเองได้");
        }

        await users.upsertLocalProfile({
          id: userId,
          username: profile?.username || centerUser?.username,
          displayName:
            req.body?.display_name !== undefined
              ? String(req.body.display_name || "").trim()
              : profile?.display_name ||
                `${centerUser?.first_name || ""} ${centerUser?.last_name || ""}`.trim(),
          department:
            req.body?.department !== undefined
              ? String(req.body.department || "").trim() || null
              : profile?.department || null,
          isActive: nextActive,
        });
        await pool.query(
          `UPDATE cms_memberships SET is_active = ? WHERE user_id = ?`,
          [nextActive ? 1 : 0, userId],
        );
      }

      const member = await users.findById(userId);
      res.json({
        data: {
          id: member.id,
          username: member.username,
          display_name: member.display_name,
          department: member.department,
          roles: member.roles,
          is_active: member.is_active,
        },
      });
    }),
  );

  app.delete(
    "/api/system/members/:userId",
    requireAuth,
    wrap(async (req, res) => {
      requireSystemManage(req);
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        throw httpError(400, "userId ไม่ถูกต้อง");
      }
      if (userId === Number(req.user.id)) {
        throw httpError(400, "ไม่สามารถถอนสิทธิ์ CMS ของตัวเองได้");
      }
      await pool.query(`DELETE FROM cms_memberships WHERE user_id = ?`, [userId]);
      res.json({ ok: true });
    }),
  );
}
