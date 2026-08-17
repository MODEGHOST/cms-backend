/**
 * LFB Auth Telegram Bot — account link + in-chat password reset.
 * Long-polls getUpdates (no public webhook needed for local/dev).
 */
import { config } from "../core/config.js";
import { passwordPolicyErrors } from "../core/password-policy.js";
import {
  applyPasswordReset,
  findValidResetTokenById,
} from "./password-reset.js";

const EMPLOYEE_CODE_PATTERN = /^\d{8}$/;

function normalizeTelegramUsername(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.username;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function createTelegramAuthBot({ pool, config: cfg = config, logger }) {
  const { botToken, enabled, username: botUsername } = cfg.telegramAuth || {};
  const center = `\`${cfg.sharedDbName}\`.\`${cfg.centerUserTable}\``;
  const baseUrl = `https://api.telegram.org/bot${botToken}`;

  /** @type {Map<string, { tokenId: number, tokenHash: string, step: 'new'|'confirm', password?: string, messageIds: number[] }>} */
  const pendingResets = new Map();

  let offset = 0;
  let stopped = false;
  let loopPromise = null;
  let expireTimer = null;

  async function api(method, body) {
    if (!enabled || !botToken) return null;
    try {
      const res = await fetch(`${baseUrl}/${method}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json();
    } catch (err) {
      logger?.error("telegram_auth.api_error", { method, error: err.message });
      return null;
    }
  }

  async function sendMessage(chatId, text, extra = {}) {
    return api("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async function answerCallback(callbackQueryId, text = "", { alert = false } = {}) {
    return api("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || undefined,
      show_alert: Boolean(text) && alert,
    });
  }

  async function tryDeleteMessage(chatId, messageId) {
    if (!messageId) return;
    const data = await api("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
    if (data && data.ok === false) {
      logger?.warn("telegram_auth.delete_failed", {
        chatId,
        messageId,
        error: data.description,
      });
    }
  }

  function resetCardText({ name }) {
    const who = name ? escapeHtml(name) : "คุณ";
    return [
      `<b>LFB Service</b>  🔑 <b>Reset Password</b>`,

      `━━━━━━━━━━━━━━━━━━━━`,
      `สวัสดีครับ คุณ <b>${who}</b>`,
      `กรุณากรอกรหัสผ่านใหม่ได้เลย`,
      `⏳ คำขอหมดอายุภายใน <b>3 นาที</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `กด <b>Reset</b> เพื่อตั้งรหัสใหม่`,
      `แล้วพิมพ์รหัสผ่านในแชทนี้ 2 ครั้ง`,
      ``,
      `กด <b>Cancel</b> ถ้าไม่ได้ต้องการแล้ว`,
      ``,
      `<i>ถ้าไม่ได้กดลืมรหัสเอง ไม่ต้องสนใจข้อความนี้ครับ</i>`,
    ].join("\n");
  }

  /**
   * Send reset card with Reset / Cancel buttons.
   * Expiry is tracked in DB (expires_at + message id) and swept by expireDueResetCards.
   */
  async function sendPasswordResetLink({
    chatId,
    tokenId,
    displayName: name,
  }) {
    const id = Number(tokenId);
    const result = await sendMessage(chatId, resetCardText({ name }), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🟢 Reset", callback_data: `rp:${id}` },
            { text: "🔴 Cancel", callback_data: `rpc:${id}` },
          ],
        ],
      },
    });

    const messageId = result?.result?.message_id;
    if (result?.ok && messageId) {
      await pool.query(
        `UPDATE password_reset_tokens
         SET telegram_chat_id = ?, telegram_message_id = ?
         WHERE id = ? AND used_at IS NULL`,
        [String(chatId), Number(messageId), id],
      );
    }

    return result;
  }

  /**
   * Expire reset cards whose DB expires_at has passed.
   * Survives process restarts (unlike in-memory setTimeout).
   */
  async function expireDueResetCards() {
    let rows;
    try {
      [rows] = await pool.query(
        `SELECT id, telegram_chat_id, telegram_message_id
         FROM password_reset_tokens
         WHERE expires_at <= NOW()
           AND used_at IS NULL
           AND telegram_message_id IS NOT NULL
         ORDER BY expires_at ASC
         LIMIT 50`,
      );
    } catch (err) {
      logger?.warn("telegram_auth.expire_lookup_failed", { error: err.message });
      return;
    }

    for (const row of rows || []) {
      const id = Number(row.id);
      const chatId = row.telegram_chat_id;
      const messageId = Number(row.telegram_message_id);

      try {
        const [updateResult] = await pool.query(
          `UPDATE password_reset_tokens
           SET used_at = NOW(), telegram_message_id = NULL
           WHERE id = ? AND used_at IS NULL`,
          [id],
        );
        if (!updateResult?.affectedRows) continue;

        const session = pendingResets.get(String(chatId));
        if (session && Number(session.tokenId) === id) {
          await finishResetCleanup(chatId, session);
        } else {
          await tryDeleteMessage(chatId, messageId);
        }

        await sendMessage(
          chatId,
          "⏳ <b>หมดเวลานะครับ</b>\nคำขอเปลี่ยนรหัสผ่านหมดอายุแล้ว\nถ้ายังต้องการ กลับไปกดลืมรหัสผ่านที่หน้าเว็บอีกครั้งได้เลย",
        );
      } catch (err) {
        logger?.warn("telegram_auth.reset_expire_failed", {
          tokenId: id,
          error: err.message,
        });
      }
    }
  }

  async function cancelResetPrompt(chatId, messageId, tokenId) {
    const key = String(chatId);
    const session = pendingResets.get(key);
    if (session && Number(session.tokenId) === Number(tokenId)) {
      await finishResetCleanup(chatId, session);
    } else if (messageId) {
      await tryDeleteMessage(chatId, messageId);
    }
    // Invalidate token so button cannot be reused
    await pool.query(
      `UPDATE password_reset_tokens
       SET used_at = NOW(), telegram_message_id = NULL
       WHERE id = ? AND used_at IS NULL`,
      [Number(tokenId)],
    );
  }

  async function findByEmployeeCode(employeeCode) {
    const [[row]] = await pool.query(
      `SELECT id, username, first_name, last_name, email, telegram_id, telegram_chat_id, status
       FROM ${center}
       WHERE username = ?
       LIMIT 1`,
      [employeeCode],
    );
    return row || null;
  }

  async function findByChatId(chatId) {
    const [[row]] = await pool.query(
      `SELECT id, username, first_name, last_name, email, telegram_id, telegram_chat_id, status
       FROM ${center}
       WHERE telegram_chat_id = ?
       LIMIT 1`,
      [String(chatId)],
    );
    return row || null;
  }

  async function findByTelegramUsername(fromUsername) {
    const actual = normalizeTelegramUsername(fromUsername);
    if (!actual) return null;
    const bare = actual.slice(1).toLowerCase();
    const [[row]] = await pool.query(
      `SELECT id, username, first_name, last_name, email, telegram_id, telegram_chat_id, status
       FROM ${center}
       WHERE LOWER(REPLACE(COALESCE(telegram_id, ''), '@', '')) = ?
       LIMIT 1`,
      [bare],
    );
    return row || null;
  }

  async function linkAccount({ employeeCode, chatId, fromUsername }) {
    const user = await findByEmployeeCode(employeeCode);
    if (!user) {
      return { ok: false, message: "ไม่พบรหัสพนักงานนี้ในระบบ" };
    }
    if (user.status === "suspended") {
      return { ok: false, message: "บัญชีนี้ถูกระงับ ไม่สามารถผูกได้" };
    }

    const expected = normalizeTelegramUsername(user.telegram_id);
    const actual = normalizeTelegramUsername(fromUsername);
    if (expected && actual && expected.toLowerCase() !== actual.toLowerCase()) {
      return {
        ok: false,
        message:
          `Telegram นี้ไม่ตรงกับที่ลงทะเบียนไว้ (${expected})\n` +
          `กรุณาใช้บัญชี Telegram เดิม หรือติดต่อแอดมิน`,
      };
    }

    const [[taken]] = await pool.query(
      `SELECT id, username FROM ${center}
       WHERE telegram_chat_id = ? AND id <> ?
       LIMIT 1`,
      [String(chatId), user.id],
    );
    if (taken) {
      return {
        ok: false,
        message: `Chat นี้ถูกผูกกับรหัสพนักงาน ${taken.username} อยู่แล้ว`,
      };
    }

    const telegramId = expected || actual || null;
    await pool.query(
      `UPDATE ${center}
       SET telegram_chat_id = ?,
           telegram_id = COALESCE(?, telegram_id)
       WHERE id = ?`,
      [String(chatId), telegramId, user.id],
    );

    return {
      ok: true,
      user,
      message:
        `ผูกบัญชีเรียบร้อยแล้วครับ\n` +
        `รหัสพนักงาน: <b>${escapeHtml(user.username)}</b>\n` +
        `ชื่อ: <b>${escapeHtml(displayName(user))}</b>\n\n` +
        `ครั้งหน้าถ้าลืมรหัสผ่าน ระบบจะส่งปุ่ม Reset มาที่แชทนี้ให้เลย`,
    };
  }

  function welcomeText() {
    const bot = botUsername ? `@${botUsername}` : "Bot";
    return [
      `👋 สวัสดีครับ`,
      `นี่คือ <b>LFB Service</b> (${escapeHtml(bot)})`,
      ``,
      `ใช้ผูกบัญชี และช่วยตั้งรหัสผ่านใหม่ตอนลืมรหัส`,
      ``,
      `ส่ง <b>รหัสพนักงาน 8 หลัก</b> มาเพื่อผูกบัญชีได้เลย`,
      `เช่น <code>24690054</code>`,
      ``,
      `คำสั่งอื่น: /status · /unlink · /cancel`,
    ].join("\n");
  }

  async function trackBotMessage(session, sendResult) {
    const messageId = sendResult?.result?.message_id;
    if (messageId) {
      session.botMessageIds = session.botMessageIds || [];
      session.botMessageIds.push(messageId);
    }
    return sendResult;
  }

  async function startResetSession(chatId, tokenRow, promptMessageId = null) {
    const session = {
      tokenId: Number(tokenRow.id),
      tokenHash: tokenRow.token_hash,
      step: "new",
      messageIds: [],
      botMessageIds: [],
      promptMessageId,
    };
    pendingResets.set(String(chatId), session);
    const sent = await sendMessage(
      chatId,
      [
        `📝 <b>ขั้นที่ 1 จาก 2</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `พิมพ์ <b>รหัสผ่านใหม่</b> ส่งมาในแชทนี้ได้เลยครับ`,
        ``,
        `📌 รหัสควรมีอย่างน้อย 8 ตัว`,
        `   มีตัวเล็ก · ตัวใหญ่ · อักขระพิเศษ`,
        `   และห้ามใช้ภาษาไทย`,
        ``,
        `⏳ ทำให้ทันก่อนหมดเวลา 3 นาทีนะครับ`,
        `ไม่อยากทำแล้ว กด 🔴 Cancel หรือพิมพ์ /cancel`,
      ].join("\n"),
    );
    await trackBotMessage(session, sent);
    pendingResets.set(String(chatId), session);
  }

  async function finishResetCleanup(chatId, session) {
    for (const messageId of session.messageIds || []) {
      await tryDeleteMessage(chatId, messageId);
    }
    for (const messageId of session.botMessageIds || []) {
      await tryDeleteMessage(chatId, messageId);
    }
    if (session.promptMessageId) {
      await tryDeleteMessage(chatId, session.promptMessageId);
    }
    pendingResets.delete(String(chatId));
  }

  async function handleResetConversation(message) {
    const chatId = message.chat.id;
    const key = String(chatId);
    const session = pendingResets.get(key);
    if (!session) return false;

    const text = String(message.text || "");
    const lower = text.trim().toLowerCase();
    if (lower === "/cancel") {
      if (message.message_id) session.messageIds.push(message.message_id);
      await finishResetCleanup(chatId, session);
      await sendMessage(chatId, "🔴 ยกเลิกแล้วครับ ไม่ได้เปลี่ยนรหัสผ่าน");
      return true;
    }

    // Track password messages to delete after success
    if (message.message_id) {
      session.messageIds.push(message.message_id);
    }

    if (session.step === "new") {
      const errors = passwordPolicyErrors(text);
      if (errors.length) {
        const sent = await sendMessage(
          chatId,
          `รหัสนี้ยังใช้ไม่ได้ครับ:\n• ${errors.join("\n• ")}\n\nลองพิมพ์ใหม่ หรือกด Cancel`,
        );
        await trackBotMessage(session, sent);
        pendingResets.set(key, session);
        return true;
      }
      session.password = text;
      session.step = "confirm";
      const sent = await sendMessage(
        chatId,
        [
          `📝 <b>ขั้นที่ 2 จาก 2</b>`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `พิมพ์รหัสผ่าน <b>อีกครั้ง</b> เพื่อยืนยันครับ`,
          `ไม่อยากทำแล้ว กด 🔴 Cancel หรือพิมพ์ /cancel`,
        ].join("\n"),
      );
      await trackBotMessage(session, sent);
      pendingResets.set(key, session);
      return true;
    }

    if (session.step === "confirm") {
      if (text !== session.password) {
        session.step = "new";
        session.password = undefined;
        const sent = await sendMessage(
          chatId,
          "รหัสสองครั้งไม่ตรงกันครับ\nพิมพ์ <b>รหัสผ่านใหม่</b> อีกครั้งได้เลย หรือกด Cancel",
        );
        await trackBotMessage(session, sent);
        pendingResets.set(key, session);
        return true;
      }

      const result = await applyPasswordReset(pool, {
        centerTableSql: center,
        tokenHash: session.tokenHash,
        password: session.password,
      });

      await finishResetCleanup(chatId, session);

      if (!result.ok) {
        await sendMessage(
          chatId,
          `ยังเปลี่ยนรหัสไม่ได้ครับ: ${escapeHtml(result.message)}\n` +
          `ลองกดลืมรหัสผ่านที่หน้าเว็บอีกครั้งนะครับ`,
        );
        return true;
      }

      await sendMessage(
        chatId,
        "✅ เปลี่ยนรหัสผ่านเรียบร้อยแล้วครับ\nกลับไปเข้าสู่ระบบได้เลย",
      );
      return true;
    }

    return true;
  }

  async function handleCallbackQuery(query) {
    const data = String(query.data || "");
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (!chatId) {
      await answerCallback(query.id);
      return;
    }

    // Cancel card
    if (data.startsWith("rpc:")) {
      const tokenId = Number(data.slice(4));
      await cancelResetPrompt(chatId, messageId, tokenId);
      await answerCallback(query.id, "ยกเลิกแล้ว");
      await sendMessage(chatId, "🔴 ยกเลิกแล้วครับ ไม่ได้เปลี่ยนรหัสผ่าน");
      return;
    }

    if (!data.startsWith("rp:")) {
      await answerCallback(query.id);
      return;
    }

    const tokenId = Number(data.slice(3));
    const tokenRow = await findValidResetTokenById(pool, tokenId);
    if (!tokenRow) {
      await answerCallback(query.id, "หมดเวลานะครับ ลองขอใหม่ที่หน้าเว็บ");
      return;
    }

    const linked = await findByChatId(chatId);
    if (!linked || Number(linked.id) !== Number(tokenRow.user_id)) {
      await answerCallback(query.id, "แชทนี้ยังไม่ได้ผูกกับบัญชีนี้ครับ");
      return;
    }

    await answerCallback(query.id);
    await startResetSession(chatId, tokenRow, messageId || null);
  }

  async function handleMessage(message) {
    const chatId = message?.chat?.id;
    const text = String(message?.text || "").trim();
    if (!chatId) return;

    if (message.chat?.type && message.chat.type !== "private") {
      await sendMessage(
        chatId,
        "Bot นี้ใช้ได้เฉพาะแชทส่วนตัวเท่านั้น กรุณาเปิดแชทตรงกับ Bot",
      );
      return;
    }

    // In-chat reset takes priority over other commands
    if (pendingResets.has(String(chatId))) {
      await handleResetConversation(message);
      return;
    }

    if (!text) return;

    const fromUsername = message.from?.username || null;
    const lower = text.toLowerCase();

    if (lower === "/cancel") {
      await sendMessage(chatId, "ไม่มีรายการรีเซ็ตที่กำลังทำอยู่");
      return;
    }

    if (lower === "/start" || lower.startsWith("/start ")) {
      const already = await findByChatId(chatId);
      if (already) {
        await sendMessage(
          chatId,
          [
            `✅ ผูกบัญชีแล้ว`,
            `รหัสพนักงาน: <b>${escapeHtml(already.username)}</b>`,
            `ชื่อ: <b>${escapeHtml(displayName(already))}</b>`,
          ].join("\n"),
        );
        return;
      }

      const payload = text.slice(6).trim();
      if (EMPLOYEE_CODE_PATTERN.test(payload)) {
        const result = await linkAccount({
          employeeCode: payload,
          chatId,
          fromUsername,
        });
        await sendMessage(chatId, result.message);
        return;
      }

      const matched = await findByTelegramUsername(fromUsername);
      if (matched) {
        const result = await linkAccount({
          employeeCode: matched.username,
          chatId,
          fromUsername,
        });
        await sendMessage(chatId, result.message);
        return;
      }

      await sendMessage(chatId, welcomeText());
      return;
    }

    if (lower === "/status") {
      const linked = await findByChatId(chatId);
      if (!linked) {
        await sendMessage(
          chatId,
          "ยังไม่ได้ผูกบัญชี\nส่งรหัสพนักงาน 8 หลักเพื่อผูก",
        );
        return;
      }
      await sendMessage(
        chatId,
        [
          `✅ ผูกบัญชีแล้ว`,
          `รหัสพนักงาน: <b>${escapeHtml(linked.username)}</b>`,
          `ชื่อ: <b>${escapeHtml(displayName(linked))}</b>`,
          `อีเมล: ${escapeHtml(linked.email)}`,
        ].join("\n"),
      );
      return;
    }

    if (lower === "/unlink") {
      const linked = await findByChatId(chatId);
      if (!linked) {
        await sendMessage(chatId, "ยังไม่ได้ผูกบัญชีอยู่แล้ว");
        return;
      }
      await pool.query(
        `UPDATE ${center} SET telegram_chat_id = NULL WHERE id = ?`,
        [linked.id],
      );
      await sendMessage(
        chatId,
        `ยกเลิกการผูกแล้ว (รหัส ${escapeHtml(linked.username)})\n` +
        `ส่งรหัสพนักงานอีกครั้งเมื่อต้องการผูกใหม่`,
      );
      return;
    }

    if (EMPLOYEE_CODE_PATTERN.test(text)) {
      const result = await linkAccount({
        employeeCode: text,
        chatId,
        fromUsername,
      });
      await sendMessage(chatId, result.message);
      return;
    }

    await sendMessage(
      chatId,
      "ไม่เข้าใจคำสั่ง\nส่งรหัสพนักงาน 8 หลัก หรือใช้ /start /status /unlink",
    );
  }

  async function pollOnce() {
    const data = await api("getUpdates", {
      offset,
      timeout: 25,
      allowed_updates: ["message", "callback_query"],
    });
    if (!data?.ok) {
      if (data?.description) {
        logger?.warn("telegram_auth.getUpdates_failed", {
          error: data.description,
        });
      }
      return;
    }
    for (const update of data.result || []) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        } else if (update.message) {
          await handleMessage(update.message);
        }
      } catch (err) {
        logger?.error("telegram_auth.handle_failed", { error: err.message });
      }
    }
  }

  async function loop() {
    logger?.info("telegram_auth.bot_started", {
      bot: botUsername || "(token set)",
    });
    while (!stopped) {
      try {
        await pollOnce();
      } catch (err) {
        logger?.error("telegram_auth.poll_error", { error: err.message });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  function start() {
    if (!enabled || !botToken) {
      logger?.info("telegram_auth.bot_disabled");
      return null;
    }
    if (loopPromise) return loopPromise;
    stopped = false;
    expireTimer = setInterval(() => {
      expireDueResetCards().catch((err) => {
        logger?.warn("telegram_auth.expire_tick_failed", { error: err.message });
      });
    }, 15_000);
    // Run once on boot in case cards expired while the process was down
    expireDueResetCards().catch(() => {});
    loopPromise = (async () => {
      await api("deleteWebhook", { drop_pending_updates: false });
      await loop();
    })();
    return loopPromise;
  }

  function stop() {
    stopped = true;
    if (expireTimer) {
      clearInterval(expireTimer);
      expireTimer = null;
    }
  }

  return {
    start,
    stop,
    sendMessage,
    sendPasswordResetLink,
    expireDueResetCards,
    findByChatId,
    api,
  };
}
