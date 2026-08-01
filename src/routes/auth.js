import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../core/config.js";
import { httpError } from "../core/http-error.js";
import {
  clearSessionCookie,
  setSessionCookie,
} from "../core/session-cookie.js";
import { createUserRepository } from "../repositories/users.js";

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    roles: user.roles || [],
    permissions: user.permissions || [],
    department: user.department || null,
  };
}

function canUseCms(user) {
  return Boolean(
    user &&
      user.is_active &&
      user.roles?.length &&
      user.shared_status !== "suspended",
  );
}

export function registerAuthRoutes(app, { pool, wrap, requireAuth }) {
  const users = createUserRepository(pool);

  app.post(
    "/api/auth/login",
    wrap(async (req, res) => {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      if (!username || !password) {
        throw httpError(400, "username and password are required");
      }

      const user = await users.findByUsername(username);
      if (!user?.password_hash) {
        throw httpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
      }

      const matched = await bcrypt.compare(password, user.password_hash);
      if (!matched) {
        throw httpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
      }

      if (!canUseCms(user)) {
        throw httpError(
          403,
          "บัญชีนี้ยังไม่ได้รับสิทธิ์เข้าใช้งาน CMS (ไม่มี cms membership/role)",
        );
      }

      await users.upsertLocalProfile({
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        department: user.department,
        isActive: true,
      });

      const token = jwt.sign(
        {
          sub: user.id,
          username: user.username,
        },
        config.jwtSecret,
        { expiresIn: config.authTokenTtl },
      );

      setSessionCookie(res, token);
      res.json({ user: toPublicUser(user) });
    }),
  );

  app.post(
    "/api/auth/logout",
    wrap(async (_req, res) => {
      clearSessionCookie(res);
      res.json({ ok: true });
    }),
  );

  app.get(
    "/api/auth/me",
    requireAuth,
    wrap(async (req, res) => {
      res.json({
        user: toPublicUser({
          id: req.user.id,
          username: req.user.username,
          display_name: req.user.display_name,
          role: req.user.role,
          roles: req.user.roles,
          permissions: req.user.permissions,
          department: req.user.department,
        }),
      });
    }),
  );
}

export async function seedAdminUser(pool) {
  if (!config.seedDemoData) return;
  const users = createUserRepository(pool);
  const count = await users.countMemberships();
  if (count > 0) return;

  await users.create({
    username: "admin",
    passwordHash: await bcrypt.hash("Admin123!", 10),
    displayName: "ผู้ดูแลระบบ",
    role: "admin",
    department: null,
    email: "admin@cms.local",
  });
}
