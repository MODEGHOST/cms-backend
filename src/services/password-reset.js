import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { passwordPolicyErrors } from "../core/password-policy.js";

/**
 * Apply a one-time password reset token.
 * @returns {{ ok: true } | { ok: false, code: string, message: string, errors?: string[] }}
 */
export async function applyPasswordReset(pool, {
  centerTableSql,
  token = null,
  tokenHash = null,
  password,
}) {
  const passwordErrors = passwordPolicyErrors(password);
  if (passwordErrors.length) {
    return {
      ok: false,
      code: "PASSWORD_POLICY_FAILED",
      message: passwordErrors[0],
      errors: passwordErrors,
    };
  }

  const hash =
    tokenHash ||
    createHash("sha256").update(String(token || "")).digest("hex");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[record]] = await conn.query(
      `SELECT prt.id, prt.user_id, c.password_hash
       FROM password_reset_tokens prt
       JOIN ${centerTableSql} c ON c.id = prt.user_id
       WHERE prt.token_hash = ?
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()
       FOR UPDATE`,
      [hash],
    );
    if (!record) {
      await conn.rollback();
      return {
        ok: false,
        code: "INVALID_TOKEN",
        message: "ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุ",
      };
    }
    if (await bcrypt.compare(password, record.password_hash)) {
      await conn.rollback();
      return {
        ok: false,
        code: "PASSWORD_REUSED",
        message: "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน",
      };
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await conn.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW(), telegram_message_id = NULL
       WHERE id = ?`,
      [record.id],
    );
    await conn.query(
      `UPDATE ${centerTableSql}
       SET password_hash = ?, token_version = COALESCE(token_version, 0) + 1
       WHERE id = ?`,
      [passwordHash, record.user_id],
    );
    await conn.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW(), telegram_message_id = NULL
       WHERE user_id = ? AND used_at IS NULL`,
      [record.user_id],
    );
    await conn.commit();
    return { ok: true, userId: record.user_id };
  } catch (error) {
    try {
      await conn.rollback();
    } catch {
      /* already rolled back */
    }
    throw error;
  } finally {
    conn.release();
  }
}

export async function findValidResetTokenById(pool, tokenId) {
  const id = Number(tokenId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [[row]] = await pool.query(
    `SELECT prt.id, prt.user_id, prt.token_hash, prt.expires_at
     FROM password_reset_tokens prt
     WHERE prt.id = ?
       AND prt.used_at IS NULL
       AND prt.expires_at > NOW()
     LIMIT 1`,
    [id],
  );
  return row || null;
}
