import bcrypt from "bcryptjs";
import { config } from "../core/config.js";
import { httpError } from "../core/http-error.js";
import { passwordPolicyErrors } from "../core/password-policy.js";
import { authRateLimit } from "../middleware/auth-rate-limit.js";
import { centerUserTableSql } from "../repositories/users.js";
import {
  createOneTimeToken,
} from "../services/communications.js";
import { passwordResetEmail } from "../services/email-templates.js";
import { applyPasswordReset } from "../services/password-reset.js";

const TELEGRAM_PATTERN = /^@?[a-zA-Z0-9_]{3,64}$/;
const EMPLOYEE_CODE_PATTERN = /^\d{8}$/;

/** Public company catalog for RegisterForm (same shape as IPMS /api/companies/public). */
export const REGISTRATION_ORG = Object.freeze({
  id: 1,
  name: "บริษัท ลี้ไฟเบอร์บอร์ด จำกัด",
  parent_id: null,
  parent_name: null,
});

function normalizeLoginId(value) {
  return String(value || "").trim().toLowerCase();
}

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

export function registerPublicAuthRoutes(app, { pool, wrap, sendEmail, telegramAuthBot }) {
  const center = centerUserTableSql(config);

  app.get(
    "/api/companies/public",
    authRateLimit({ limit: 60 }),
    wrap(async (_req, res) => {
      res.json([REGISTRATION_ORG]);
    }),
  );

  app.post(
    "/api/auth/register",
    authRateLimit({ limit: 5 }),
    wrap(async (req, res) => {
      const {
        employeeCode,
        firstName,
        lastName,
        email,
        telegramId,
        password,
        companyId,
      } = req.body || {};

      const normalizedEmail = String(email || "").trim().toLowerCase();
      const normalizedEmployeeCode = String(employeeCode || "").trim();
      const loginId = normalizeLoginId(normalizedEmployeeCode);
      const normalizedTelegram = normalizeTelegramId(telegramId);

      if (
        !normalizedEmployeeCode ||
        !firstName?.trim() ||
        !lastName?.trim() ||
        !normalizedEmail ||
        !password ||
        !companyId
      ) {
        throw httpError(400, "กรุณากรอกข้อมูลสมัครสมาชิกให้ครบถ้วน");
      }
      if (!EMPLOYEE_CODE_PATTERN.test(normalizedEmployeeCode)) {
        throw httpError(400, "รหัสพนักงานต้องเป็นตัวเลข 8 หลัก");
      }
      if (Number(companyId) !== REGISTRATION_ORG.id) {
        throw httpError(400, "บริษัทไม่เปิดรับสมัคร");
      }
      const badTelegram = telegramError(normalizedTelegram);
      if (badTelegram) throw httpError(400, badTelegram);

      const passwordErrors = passwordPolicyErrors(password);
      if (passwordErrors.length) {
        const err = httpError(400, passwordErrors[0]);
        err.code = "PASSWORD_POLICY_FAILED";
        err.errors = passwordErrors;
        throw err;
      }

      const [[existingLogin]] = await pool.query(
        `SELECT id FROM ${center} WHERE username = ? LIMIT 1`,
        [loginId],
      );
      if (existingLogin) {
        throw httpError(
          409,
          "บัญชีนี้มีอยู่ในระบบกลางแล้ว กรุณาเข้าสู่ระบบ หากยังเข้า CMS ไม่ได้ ให้ผู้ดูแลเปิดสิทธิ์ให้",
        );
      }
      const [[existingEmail]] = await pool.query(
        `SELECT id FROM ${center} WHERE email = ? LIMIT 1`,
        [normalizedEmail],
      );
      if (existingEmail) {
        throw httpError(
          409,
          "อีเมลนี้ถูกใช้แล้ว กรุณาเข้าสู่ระบบ หากยังเข้า CMS ไม่ได้ ให้ผู้ดูแลเปิดสิทธิ์ให้",
        );
      }
      if (normalizedTelegram) {
        const [[existingTelegram]] = await pool.query(
          `SELECT id FROM ${center} WHERE telegram_id = ? LIMIT 1`,
          [normalizedTelegram],
        );
        if (existingTelegram) {
          throw httpError(409, "Telegram ID นี้ถูกใช้แล้ว");
        }
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const displayName = `${firstName.trim()} ${lastName.trim()}`;
      const conn = await pool.getConnection();
      let userId;
      try {
        await conn.beginTransaction();
        const [centerResult] = await conn.query(
          `INSERT INTO ${center}
             (first_name, last_name, email, username, telegram_id, password_hash,
              department, status, token_version)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'active', 0)`,
          [
            firstName.trim(),
            lastName.trim(),
            normalizedEmail,
            loginId,
            normalizedTelegram,
            passwordHash,
          ],
        );
        userId = Number(centerResult.insertId);
        await conn.query(
          `INSERT INTO users
             (id, username, password_hash, display_name, role, department, is_active)
           VALUES (?, ?, '', ?, 'staff', NULL, 1)`,
          [userId, loginId, displayName],
        );
        // No cms_memberships yet — admin grants access from System page.
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally {
        conn.release();
      }

      res.status(201).json({
        id: userId,
        message:
          "สมัครสมาชิกแล้ว กรุณารอผู้ดูแลระบบอนุมัติก่อนเข้าสู่ระบบ",
      });
    }),
  );

  app.post(
    "/api/auth/forgot-password",
    authRateLimit({ limit: 5 }),
    wrap(async (req, res) => {
      const email = String(req.body?.email || "").trim().toLowerCase();
      if (!email) {
        throw httpError(400, "กรุณากรอกอีเมล");
      }

      const [[user]] = await pool.query(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.telegram_chat_id
         FROM ${center} c
         WHERE c.email = ?
           AND c.status <> 'suspended'
         LIMIT 1`,
        [email],
      );

      if (user) {
        const { token, hash } = createOneTimeToken();
        const resetUrl = `${config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const [insertResult] = await pool.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 3 MINUTE))`,
          [user.id, hash],
        );
        const tokenId = Number(insertResult.insertId);

        const displayName = [user.first_name, user.last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        let deliveredVia = "email";

        if (user.telegram_chat_id && telegramAuthBot) {
          const tg = await telegramAuthBot.sendPasswordResetLink({
            chatId: user.telegram_chat_id,
            tokenId,
            displayName,
          });
          if (tg?.ok) {
            deliveredVia = "telegram";
          } else {
            const template = passwordResetEmail({ url: resetUrl });
            await sendEmail({
              to: user.email,
              ...template,
              developmentUrl: resetUrl,
            });
            deliveredVia = "email_fallback";
          }
        } else {
          const template = passwordResetEmail({ url: resetUrl });
          await sendEmail({
            to: user.email,
            ...template,
            developmentUrl: resetUrl,
          });
        }

        if (deliveredVia === "telegram") {
          res.json({
            message:
              "หากพบบัญชี ระบบจะส่งปุ่ม Reset Password ทาง Telegram ที่ผูกไว้",
            channel: "telegram",
          });
          return;
        }
      }

      res.json({
        message: "หากพบอีเมล ระบบจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้",
      });
    }),
  );

  app.post(
    "/api/auth/reset-password",
    authRateLimit({ limit: 5 }),
    wrap(async (req, res) => {
      const password = String(req.body?.password || "");
      const passwordErrors = passwordPolicyErrors(password);
      if (passwordErrors.length) {
        const err = httpError(400, passwordErrors[0]);
        err.code = "PASSWORD_POLICY_FAILED";
        err.errors = passwordErrors;
        throw err;
      }

      const result = await applyPasswordReset(pool, {
        centerTableSql: center,
        token: String(req.body?.token || ""),
        password,
      });
      if (!result.ok) {
        const err = httpError(400, result.message);
        if (result.code) err.code = result.code;
        if (result.errors) err.errors = result.errors;
        throw err;
      }

      res.json({ message: "ตั้งรหัสผ่านใหม่แล้ว" });
    }),
  );
}
