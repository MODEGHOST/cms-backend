import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";

// --- Telegram Bot API ---

export function createTelegramService({ config, logger }) {
  const { botToken, enabled, groupChatId, groupInviteLink } = config.telegram;
  const baseUrl = `https://api.telegram.org/bot${botToken}`;
  let cachedInviteLink = groupInviteLink || null;

  async function sendMessage(chatId, text, options = {}) {
    if (!enabled || !botToken) {
      logger.info("telegram.disabled", { chatId, text: text.slice(0, 100) });
      return null;
    }

    const body = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || "HTML",
      disable_web_page_preview: true,
      ...options.extra,
    };

    try {
      const res = await fetch(`${baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) {
        logger.warn("telegram.send_failed", { chatId, error: data.description });
      }
      return data;
    } catch (err) {
      logger.error("telegram.network_error", { chatId, error: err.message });
      return null;
    }
  }

  async function sendToMultiple(chatIds, text, options = {}) {
    const results = await Promise.allSettled(
      chatIds.filter(Boolean).map((id) => sendMessage(id, text, options))
    );
    return results;
  }

  /**
   * Invite link only — never adds members automatically.
   * User must tap the link themselves to join the CMS group.
   */
  async function getGroupInviteLink() {
    if (cachedInviteLink) return cachedInviteLink;
    if (!enabled || !botToken || !groupChatId) return null;

    try {
      const res = await fetch(`${baseUrl}/exportChatInviteLink`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: groupChatId }),
      });
      const data = await res.json();
      if (data.ok && data.result) {
        cachedInviteLink = data.result;
        return cachedInviteLink;
      }
      logger.warn("telegram.invite_link_failed", {
        error: data.description || "exportChatInviteLink failed",
      });
    } catch (err) {
      logger.error("telegram.invite_link_error", { error: err.message });
    }
    return null;
  }

  return { sendMessage, sendToMultiple, getGroupInviteLink };
}

export function createOneTimeToken() {
  const token = randomBytes(32).toString("hex");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

export function createEmailService({ config, logger }) {
  const smtp = config.smtp;
  const transporter =
    smtp?.user && smtp?.pass
      ? nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: {
            user: smtp.user,
            pass: smtp.pass,
          },
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        })
      : null;

  return async function sendEmail({ to, subject, html, text, developmentUrl }) {
    if (!transporter) {
      logger.info("email.development_link", { to, subject, developmentUrl });
      return;
    }
    await transporter.sendMail({
      from: config.emailFrom,
      to,
      subject,
      html,
      text,
    });
  };
}
