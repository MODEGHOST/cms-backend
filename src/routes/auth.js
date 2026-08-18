import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../core/config.js";
import { httpError } from "../core/http-error.js";
import {
  clearSessionCookie,
  setSessionCookie,
} from "../core/session-cookie.js";
import { authRateLimit } from "../middleware/auth-rate-limit.js";
import { createUserRepository, centerUserTableSql } from "../repositories/users.js";

const TELEGRAM_PATTERN = /^@?[a-zA-Z0-9_]{3,64}$/;

function normalizeTelegramId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.startsWith("@") ? raw : raw;
}

function telegramError(telegramId) {
  if (!telegramId) return null;
  if (!TELEGRAM_PATTERN.test(telegramId)) {
    return "รูปแบบ Telegram ID ไม่ถูกต้อง";
  }
  return null;
}

function telegramBotStartUrl(employeeCode) {
  const bot = config.telegramAuth?.username;
  if (!bot || !employeeCode) return null;
  return `https://t.me/${bot}?start=${encodeURIComponent(String(employeeCode))}`;
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    email: user.email || null,
    telegram_id: user.telegram_id || null,
    telegram_linked: Boolean(user.telegram_chat_id),
    telegram_bot_url: telegramBotStartUrl(user.username),
    telegram_bot_username: config.telegramAuth?.username
      ? `@${config.telegramAuth.username}`
      : null,
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

export function registerAuthRoutes(app, { pool, wrap, requireAuth, telegram }) {
  const users = createUserRepository(pool);

  app.post(
    "/api/auth/login",
    authRateLimit({ limit: 5, windowMs: 3 * 60 * 1000 }),
    wrap(async (req, res) => {
      const username = String(
        req.body?.employeeCode || req.body?.username || "",
      )
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      if (!username || !password) {
        throw httpError(400, "กรุณากรอกรหัสพนักงานและรหัสผ่าน");
      }

      const user = await users.findByUsername(username);
      if (!user?.password_hash) {
        throw httpError(401, "รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง");
      }

      const matched = await bcrypt.compare(password, user.password_hash);
      if (!matched) {
        throw httpError(401, "รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง");
      }

      if (!canUseCms(user)) {
        throw httpError(
          403,
          "บัญชียังไม่ได้รับอนุมัติจากผู้ดูแลระบบ",
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
          id: user.id,
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
        user: toPublicUser(req.user),
      });
    }),
  );

  app.patch(
    "/api/auth/me",
    requireAuth,
    wrap(async (req, res) => {
      const center = centerUserTableSql(config);
      const emailProvided = Object.hasOwn(req.body || {}, "email");
      const telegramProvided = Object.hasOwn(req.body || {}, "telegram_id")
        || Object.hasOwn(req.body || {}, "telegramId");

      const normalizedEmail = emailProvided
        ? String(req.body.email || "").trim().toLowerCase()
        : undefined;
      const telegramRaw = telegramProvided
        ? (Object.hasOwn(req.body || {}, "telegram_id")
          ? req.body.telegram_id
          : req.body.telegramId)
        : undefined;
      const normalizedTelegram = telegramProvided
        ? normalizeTelegramId(telegramRaw)
        : undefined;

      if (emailProvided) {
        if (!normalizedEmail) {
          throw httpError(400, "กรุณากรอกอีเมล");
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
          throw httpError(400, "รูปแบบอีเมลไม่ถูกต้อง");
        }
        const [[takenEmail]] = await pool.execute(
          `SELECT id FROM ${center} WHERE email = ? AND id <> ? LIMIT 1`,
          [normalizedEmail, req.user.id],
        );
        if (takenEmail) {
          throw httpError(409, "อีเมลนี้ถูกใช้แล้ว");
        }
      }

      if (telegramProvided) {
        const badTelegram = telegramError(normalizedTelegram);
        if (badTelegram) throw httpError(400, badTelegram);
        if (normalizedTelegram) {
          const [[taken]] = await pool.execute(
            `SELECT id FROM ${center} WHERE telegram_id = ? AND id <> ? LIMIT 1`,
            [normalizedTelegram, req.user.id],
          );
          if (taken) {
            throw httpError(409, "Telegram ID นี้ถูกใช้แล้ว");
          }
        }
      }

      const fields = [];
      const values = [];
      if (emailProvided) {
        fields.push("email = ?");
        values.push(normalizedEmail);
      }
      if (telegramProvided) {
        fields.push("telegram_id = ?");
        values.push(normalizedTelegram);
      }
      if (!fields.length) {
        throw httpError(400, "ไม่มีข้อมูลให้อัปเดต");
      }

      values.push(req.user.id);
      await pool.execute(
        `UPDATE ${center} SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );

      const updated = await users.findById(req.user.id);
      res.json({
        message: telegramProvided
          ? (normalizedTelegram
            ? "ผูก Telegram ID กับบัญชีแล้ว"
            : "ยกเลิกการผูก Telegram ID แล้ว")
          : "บันทึกข้อมูลแล้ว",
        user: toPublicUser(updated),
      });
    }),
  );

  app.get(
    "/api/auth/telegram-group",
    requireAuth,
    wrap(async (req, res) => {
      if (!req.user.telegram_id) {
        throw httpError(400, "กรุณาผูก Telegram ID กับบัญชีก่อนเข้ากลุ่ม");
      }
      const inviteUrl = await telegram?.getGroupInviteLink?.();
      if (!inviteUrl) {
        throw httpError(
          503,
          "ยังไม่สามารถสร้างลิงก์เข้ากลุ่มได้ กรุณาติดต่อผู้ดูแลระบบ",
        );
      }
      res.json({
        inviteUrl,
        telegram_id: req.user.telegram_id,
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
