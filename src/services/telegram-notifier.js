import {
  complaintStatusChanged,
  rejectCreated,
  rejectReturnedToCs,
  rejectStatusChanged,
  documentDeadlineApproaching,
} from "./telegram-templates.js";
import { CS_AUDIENCE_DEPARTMENTS } from "../utils/department-permissions.js";

/**
 * Sends Telegram notifications on complaint / reject workflow events.
 * If TELEGRAM_GROUP_CHAT_ID is set, all events go to that group (dev/solo mode).
 * Otherwise looks up recipients by department (Role is access-level only).
 */
export function createTelegramNotifier({ telegram, users, config, logger }) {
  const groupChatId = config.telegram?.groupChatId || null;

  async function getRecipientChatIds(departmentNames, matchDepartmentId = null) {
    if (groupChatId) return [groupChatId];

    try {
      const recipients = await users.findByDepartments(
        departmentNames,
        matchDepartmentId,
      );
      return recipients.map((u) => u.telegram_id).filter(Boolean);
    } catch (err) {
      logger.warn("telegram_notifier.recipient_lookup_failed", {
        error: err.message,
      });
      return [];
    }
  }

  /** Status → departments to notify (null = use responsible_department_id). */
  const COMPLAINT_DEPT_MAP = {
    pending_qa: ["QA"],
    qa_review: ["QA"],
    pending_department: null,
    department_action: null,
    qa_confirm: ["QA"],
    closed: [...CS_AUDIENCE_DEPARTMENTS, "QA"],
    completed: [...CS_AUDIENCE_DEPARTMENTS, "QA"],
  };

  const COMPLAINT_NOTIFY_STATUSES = new Set(Object.keys(COMPLAINT_DEPT_MAP));

  async function sendNotification(chatIds, message) {
    const text = typeof message === "string" ? message : message?.text;
    if (!text) return;

    const replyMarkup =
      typeof message === "object" && message?.replyMarkup
        ? message.replyMarkup
        : null;

    await telegram.sendToMultiple(chatIds, text, {
      extra: replyMarkup ? { reply_markup: replyMarkup } : undefined,
    });
  }

  async function onStatusChange(complaint, newStatus, actor = null) {
    if (!COMPLAINT_NOTIFY_STATUSES.has(newStatus)) return;
    if (!groupChatId && !(newStatus in COMPLAINT_DEPT_MAP)) return;

    const depts = COMPLAINT_DEPT_MAP[newStatus];
    const chatIds = await getRecipientChatIds(
      depts || [],
      depts == null ? complaint.responsible_department_id : null,
    );
    if (!chatIds.length) return;

    const message = complaintStatusChanged({
      complaint,
      newStatus,
      frontendUrl: config.frontendUrl,
      actor,
    });

    await sendNotification(chatIds, message);
  }

  async function onRejectCreated(reject, actor = null) {
    if (!reject?.id) return;

    const chatIds = await getRecipientChatIds(["QC"], null);
    if (!chatIds.length) return;

    const message = rejectCreated({
      reject,
      frontendUrl: config.frontendUrl,
      actor,
    });

    await sendNotification(chatIds, message);
  }

  async function onRejectUpdated(reject, actor = null) {
    if (!reject?.id) return;

    const chatIds = await getRecipientChatIds(CS_AUDIENCE_DEPARTMENTS, null);
    if (!chatIds.length) return;

    const message = rejectStatusChanged({
      reject,
      newStatus: "updated",
      frontendUrl: config.frontendUrl,
      actor,
    });

    await sendNotification(chatIds, message);
  }

  async function onRejectReturnedToCs(reject, reason, actor = null) {
    if (!reject?.id) return;

    const chatIds = await getRecipientChatIds(CS_AUDIENCE_DEPARTMENTS, null);
    if (!chatIds.length) return;

    const message = rejectReturnedToCs({
      reject,
      reason,
      frontendUrl: config.frontendUrl,
      actor,
    });

    await sendNotification(chatIds, message);
  }

  async function onDocumentDeadlineApproaching(complaint, meta = {}) {
    if (!complaint?.id) return;

    const chatIds = groupChatId
      ? [groupChatId]
      : await getRecipientChatIds([...CS_AUDIENCE_DEPARTMENTS, "QA"], null);
    if (!chatIds.length) return;

    const message = documentDeadlineApproaching({
      complaint,
      frontendUrl: config.frontendUrl,
      daysLeft: meta.daysLeft,
      deadlineDate: meta.deadlineDate,
      acceptedAt: meta.acceptedAt || complaint.document_accepted_at,
    });

    await sendNotification(chatIds, message);
  }

  return {
    onStatusChange,
    onRejectCreated,
    onRejectUpdated,
    onRejectReturnedToCs,
    onDocumentDeadlineApproaching,
  };
}
