import { formatProblemLabel } from "../utils/problem-names.js";

const COMPLAINT_STATUS_LABELS = {
  cs_draft: "CS Draft",
  pending_qa: "รอ QA รับเรื่อง",
  qa_review: "QA กำลังตรวจสอบ",
  pending_department: "รอหน่วยงานรับเรื่อง",
  department_action: "หน่วยงานกำลังดำเนินการ",
  qa_confirm: "รอ QA Confirm",
  completed: "ปิดงานแล้ว",
  closed: "ปิดเรื่อง",
};

const REJECT_STATUS_LABELS = {
  pending_qc: "รอ QC กรอกข้อมูล",
  updated: "QC อัปเดตแล้ว",
  returned_to_cs: "QC ตีกลับไป CS",
};

/** Next step for the person who must act (omit when work is done). */
const COMPLAINT_NEXT_STEP = {
  pending_qa: () => "ขั้นตอนถัดไป: QA รับเรื่อง",
  qa_review: () => "ขั้นตอนถัดไป: QA กรอกข้อมูลแล้ว Submit",
  pending_department: (dept) =>
    dept
      ? `ขั้นตอนถัดไป: ${dept} รับเรื่อง`
      : "ขั้นตอนถัดไป: หน่วยงานที่รับผิดชอบรับเรื่อง",
  department_action: (dept) =>
    dept
      ? `ขั้นตอนถัดไป: ${dept} กรอกสาเหตุ/แก้ไข/ป้องกัน แล้ว Submit`
      : "ขั้นตอนถัดไป: หน่วยงานกรอกสาเหตุ/แก้ไข/ป้องกัน แล้ว Submit",
  qa_confirm: () => "ขั้นตอนถัดไป: QA Confirm เพื่อปิดงาน",
};

const REJECT_NEXT_STEP = {
  pending_qc: () => "ขั้นตอนถัดไป: QC กรอกข้อมูล Reject",
  updated: () => "QC กรอก/อัปเดตข้อมูล Reject แล้ว",
  returned_to_cs: () =>
    "ขั้นตอนถัดไป: ตรวจ Complaint อีกครั้ง ถ้ายังต้องซ่อมให้ส่งมาใหม่",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function pdrLabel(record) {
  return record?.pdr_no || record?.complaint_no || record?.document_no || record?.id;
}

function responsibleDepartment(record) {
  return (
    record?.responsible_department_name ||
    record?.responsible_department ||
    record?.department_name ||
    null
  );
}

function formatActorName(actor) {
  if (!actor) return null;
  const display = String(actor.display_name || "").trim();
  const account = String(actor.username || "").trim();
  return display || account || null;
}

function formatActorDepartment(actor) {
  if (!actor) return null;
  const dept = String(actor.department || "").trim();
  return dept || null;
}

/** Previous actor: "จาก: Name · แผนก: PD" */
function actorLine(actor) {
  const who = formatActorName(actor);
  if (!who) return null;
  const name = escapeHtml(who);
  const dept = formatActorDepartment(actor);
  return dept
    ? `จาก: <b>${name}</b> · แผนก: <b>${escapeHtml(dept)}</b>`
    : `จาก: <b>${name}</b>`;
}

function nextStepLine(nextMap, status, dept) {
  const builder = nextMap[status];
  return builder ? builder(dept) : null;
}

/** Title: 🔔 CMS - Complaint รอ QA รับเรื่อง */
function cmsTitle(workType, statusLabel) {
  return `🔔 <b>CMS - ${escapeHtml(workType)} ${escapeHtml(statusLabel)}</b>`;
}

function bodyLines({
  record,
  status,
  nextStepMap,
  actor,
}) {
  const id = escapeHtml(pdrLabel(record));
  const dept = responsibleDepartment(record);
  const next = nextStepLine(nextStepMap, status, dept);

  return [
    `PDR: <b>${id}</b>`,
    dept ? `หน่วยงานรับผิดชอบ: <b>${escapeHtml(dept)}</b>` : null,
    formatProblemLabel(record)
      ? `ปัญหา: ${escapeHtml(formatProblemLabel(record))}`
      : null,
    actorLine(actor),
    next ? `<b>${escapeHtml(next)}</b>` : null,
  ].filter(Boolean);
}

/** Deep link that opens the SPA complaint form for this record. */
export function complaintOpenUrl(complaint, frontendUrl) {
  const pdr = encodeURIComponent(String(complaint?.pdr_no || "").trim());
  const id = encodeURIComponent(String(complaint?.id ?? "").trim());
  return `${frontendUrl}/complaint-form?pdr=${pdr}&id=${id}`;
}

/** Deep link that opens the SPA reject form for this record. */
export function rejectOpenUrl(reject, frontendUrl) {
  const pdr = encodeURIComponent(String(reject?.pdr_no || "").trim());
  const id = encodeURIComponent(String(reject?.id ?? "").trim());
  return `${frontendUrl}/reject-form?pdr=${pdr}&id=${id}`;
}

/** Telegram rejects localhost on URL buttons, but allows LAN http IPs. */
function isTelegramUrlButtonSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
    // Hostnames need a dot (e.g. cms.local) — bare names like "lfb-cms" are rejected.
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
    if (!isIp && !host.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Telegram inline keyboard with a single URL button. */
export function openInSystemKeyboard(url) {
  if (!url || !isTelegramUrlButtonSafe(url)) return null;
  return {
    inline_keyboard: [[{ text: "เปิดในระบบ", url }]],
  };
}

function withOpenButton(lines, url) {
  const replyMarkup = openInSystemKeyboard(url);
  const body = [...lines];
  // Local/dev URLs cannot be Telegram buttons — keep a tappable HTML link instead.
  if (url && !replyMarkup) {
    body.push(``, `<a href="${url}">เปิดในระบบ</a>`);
  }
  return {
    text: body.filter((line) => line != null).join("\n"),
    replyMarkup,
  };
}

export function complaintStatusChanged({
  complaint,
  newStatus,
  frontendUrl,
  actor,
}) {
  const statusLabel =
    COMPLAINT_STATUS_LABELS[newStatus] || newStatus;
  const link = complaintOpenUrl(complaint, frontendUrl);

  return withOpenButton(
    [
      cmsTitle("Complaint", statusLabel),
      ``,
      ...bodyLines({
        record: complaint,
        status: newStatus,
        nextStepMap: COMPLAINT_NEXT_STEP,
        actor,
      }),
    ],
    link,
  );
}

export function rejectStatusChanged({
  reject,
  newStatus = "pending_qc",
  frontendUrl,
  actor,
}) {
  const statusLabel = REJECT_STATUS_LABELS[newStatus] || newStatus;
  const link = rejectOpenUrl(reject, frontendUrl);

  return withOpenButton(
    [
      cmsTitle("Reject", statusLabel),
      ``,
      ...bodyLines({
        record: reject,
        status: newStatus,
        nextStepMap: REJECT_NEXT_STEP,
        actor,
      }),
    ],
    link,
  );
}

export function rejectCreated({ reject, frontendUrl, actor }) {
  return rejectStatusChanged({
    reject,
    newStatus: "pending_qc",
    frontendUrl,
    actor,
  });
}

export function rejectReturnedToCs({
  reject,
  reason,
  frontendUrl,
  actor,
}) {
  const pdr = escapeHtml(pdrLabel(reject));
  const complaintId = reject?.source_complaint_id;
  const link =
    complaintId && reject?.pdr_no
      ? complaintOpenUrl(
          { id: complaintId, pdr_no: reject.pdr_no },
          frontendUrl,
        )
      : null;
  const note = String(reason || "").trim();

  return withOpenButton(
    [
      cmsTitle("Reject", "QC ตีกลับไป CS"),
      ``,
      `PDR: <b>${pdr}</b>`,
      actorLine(actor),
      note ? `เหตุผล: ${escapeHtml(note)}` : null,
      `<b>${escapeHtml(REJECT_NEXT_STEP.returned_to_cs())}</b>`,
    ],
    link,
  );
}

/** Warn group that PDR document deadline (3 days from รับเอกสาร) is near / due. */
export function documentDeadlineApproaching({
  complaint,
  frontendUrl,
  daysLeft,
  deadlineDate,
  acceptedAt,
}) {
  const pdr = escapeHtml(pdrLabel(complaint));
  const link = complaintOpenUrl(complaint, frontendUrl);
  const dept = responsibleDepartment(complaint);
  const left = Number(daysLeft);
  const headline =
    left < 0
      ? "เลยกำหนดส่งเอกสารแล้ว"
      : left === 0
        ? "ครบกำหนดส่งเอกสารวันนี้"
        : "ใกล้ถึงกำหนดส่งเอกสารแล้ว";

  return withOpenButton(
    [
      `⚠️ <b>CMS - ${headline}</b>`,
      ``,
      `PDR: <b>${pdr}</b>`,
      dept ? `หน่วยงานรับผิดชอบ: <b>${escapeHtml(dept)}</b>` : null,
      acceptedAt
        ? `วันรับเอกสาร: <b>${escapeHtml(String(acceptedAt).slice(0, 10))}</b>`
        : null,
      deadlineDate
        ? `กำหนดส่งภายใน: <b>${escapeHtml(String(deadlineDate).slice(0, 10))}</b> (3 วัน)`
        : null,
      left < 0
        ? `<b>เลยกำหนดมาแล้ว ${escapeHtml(String(Math.abs(left)))} วัน</b>`
        : left === 0
          ? `<b>ครบ 3 วันแล้ววันนี้ — กรุณาส่งเอกสารให้ทัน</b>`
          : `<b>เหลืออีก ${escapeHtml(String(left))} วัน — กรุณาเร่งดำเนินการ</b>`,
    ],
    link,
  );
}
