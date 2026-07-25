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
  };
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
      if (!user || !user.is_active) {
        throw httpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
      }

      const matched = await bcrypt.compare(password, user.password_hash);
      if (!matched) {
        throw httpError(401, "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
      }

      const token = jwt.sign(
        {
          sub: user.id,
          username: user.username,
          role: user.role,
          display_name: user.display_name,
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
      const user = await users.findById(req.user.sub);
      if (!user || !user.is_active) {
        clearSessionCookie(res);
        throw httpError(401, "Unauthorized");
      }
      res.json({ user: toPublicUser(user) });
    }),
  );
}

export async function seedAdminUser(pool) {
  if (!config.seedDemoData) return;
  const users = createUserRepository(pool);
  const count = await users.countAll();
  if (count > 0) return;

  const passwordHash = await bcrypt.hash("Admin123!", 10);
  await users.create({
    username: "admin",
    passwordHash,
    displayName: "ผู้ดูแลระบบ",
    role: "admin",
  });
}
