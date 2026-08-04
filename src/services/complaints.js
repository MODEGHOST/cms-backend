import { toDateOnly } from "../validators/common.js";
import { canCsWork, canDepartmentWork, canQaWork, isCmsAdmin } from "../core/authz.js";
import { normalizePlanForm } from "./plan-form.js";

const TEXT = "text";
const NUMBER = "number";
const DATE = "date";
const MASTER = "master";

export const COMPLAINT_FIELD_META = {
  cs: {
    problem_name: ["ปัญหา", MASTER],
    ng_qty: ["ของเสีย / NG Qty", NUMBER],
    received_date: ["วันที่รับเรื่อง", DATE],
    document_accepted: ["เอกสาร Action plan", TEXT],
  },
  qa: {
    reported_by_department_name: ["หน่วยงานที่แจ้งปัญหา", MASTER],
    responsible_department_name: ["หน่วยงานที่รับผิดชอบ", MASTER],
    document_accepted: ["เอกสาร Action plan", TEXT],
    document_scope: ["เอกสารภายใน/ภายนอก", TEXT],
    document_no: ["เลขที่เอกสาร", TEXT],
  },
  department: {
    cause: ["สาเหตุ", TEXT],
    correction: ["แก้ไข", TEXT],
    prevention: ["ป้องกัน", TEXT],
    completed_date: ["วันที่แก้ไขแล้วเสร็จ", DATE],
    remark: ["หมายเหตุ", TEXT],
  },
};

const STATUS_CONFIG = {
  cs_draft: {
    group: "cs",
    next: "pending_qa",
    submittedBy: "cs_submitted_by",
    submittedAt: "cs_submitted_at",
  },
  pending_qa: {
    group: "cs",
    next: "pending_qa",
    submittedBy: "cs_submitted_by",
    submittedAt: "cs_submitted_at",
  },
  qa_review: {
    group: "qa",
    next: "pending_department",
    submittedBy: "qa_submitted_by",
    submittedAt: "qa_submitted_at",
  },
  pending_department: {
    group: "qa",
    next: "pending_department",
    submittedBy: "qa_submitted_by",
    submittedAt: "qa_submitted_at",
  },
  department_action: {
    group: "department",
    next: "qa_confirm",
    submittedBy: "department_submitted_by",
    submittedAt: "department_submitted_at",
  },
};

const REQUIRED_ON_SUBMIT = {
  cs: ["problem_name", "ng_qty", "received_date", "document_accepted"],
  qa: ["reported_by_department_name", "responsible_department_name", "document_accepted"],
  department: ["cause", "correction", "prevention"],
};

const QA_REQUIRED_WHEN_P = ["document_scope", "document_no"];

function normalizeDocumentAccepted(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === "P" || upper === "O") return upper;
  return null;
}

function normalizeDocumentScope(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const text = String(value).trim();
  if (text === "ภายใน" || text === "ภายนอก") return text;
  return null;
}

function normalize(type, value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  if (type === DATE) return toDateOnly(value);
  if (type === NUMBER) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return String(value).trim();
}

function toLocalDateOnly(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarDayDiff(fromValue, toValue) {
  const from = toLocalDateOnly(fromValue);
  const to = toLocalDateOnly(toValue);
  if (!from || !to) return null;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const fromUtc = Date.UTC(fy, fm - 1, fd);
  const toUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtc - fromUtc) / 86400000);
}

function resolveDepartmentDocMeta(current, actor, acceptAt) {
  const forwardDate =
    toLocalDateOnly(current.qa_submitted_at) ||
    toDateOnly(current.doc_forward_date) ||
    toLocalDateOnly(acceptAt);

  const existingReceiver = String(current.doc_receiver || "").trim();
  const receiver =
    existingReceiver || String(actor.display_name || "").trim() || null;

  const replyDate =
    toDateOnly(current.doc_reply_date) || toLocalDateOnly(acceptAt);
  const csSaleDate =
    toDateOnly(current.doc_cs_sale_date) || toLocalDateOnly(acceptAt);

  const leadEnd = toDateOnly(current.doc_reply_date) || acceptAt;
  const leadTime =
    current.lead_time_days == null || current.lead_time_days === ""
      ? calendarDayDiff(current.qa_submitted_at || forwardDate, leadEnd)
      : Number(current.lead_time_days);

  return {
    doc_forward_date: forwardDate,
    doc_receiver: receiver,
    doc_reply_date: replyDate,
    doc_cs_sale_date: csSaleDate,
    lead_time_days: Number.isFinite(leadTime) ? leadTime : null,
  };
}

function resolveQaNextStatus(documentAccepted) {
  return documentAccepted === "O" ? "qa_confirm" : "pending_department";
}

function isCsUser(actor) {
  return canCsWork(actor);
}

function isQaUser(actor) {
  return canQaWork(actor);
}

function normalizeDeptName(value) {
  return String(value || "").trim().toUpperCase();
}

function isResponsibleDepartmentUser(actor, record) {
  if (isCmsAdmin(actor)) return true;
  if (!canDepartmentWork(actor)) return false;
  const userDept = normalizeDeptName(actor.department);
  const responsible = normalizeDeptName(record.responsible_department_name);
  return Boolean(userDept && responsible && userDept === responsible);
}

function canWork(status, actor, record) {
  if (isCmsAdmin(actor)) return true;
  if (status === "cs_draft" || status === "pending_qa") {
    return isCsUser(actor) || (status === "pending_qa" && isQaUser(actor));
  }
  if (status === "qa_review" || status === "qa_confirm") {
    return isQaUser(actor);
  }
  if (status === "pending_department") {
    return isQaUser(actor) || isResponsibleDepartmentUser(actor, record);
  }
  if (status === "department_action") {
    return isResponsibleDepartmentUser(actor, record);
  }
  return false;
}

function displayDocumentAccepted(value) {
  const code = String(value || "").trim().toUpperCase();
  if (code === "P") return "รับเอกสาร";
  if (code === "O") return "ไม่รับเอกสาร";
  return value == null || value === "" ? "(ว่าง)" : String(value);
}

function display(value) {
  return value == null || value === "" ? "(ว่าง)" : String(value);
}

function displayChangeValue(field, value) {
  if (field === "document_accepted") return displayDocumentAccepted(value);
  return display(value);
}

export function createComplaintService(complaints, activityLogs) {
  return {
    async updateCurrentStep(id, payload, actor) {
      const current = await complaints.findById(id);
      if (!current) {
        const error = new Error("ไม่พบรายการ Complaint");
        error.status = 404;
        throw error;
      }

      const status = current.workflow_status || "cs_draft";

      // จัดวางรูปใน PDF — อนุญาตตอนหน่วยงาน/QA Confirm และหลังปิดงาน (QA แก้ได้)
      if (payload.action === "save_pdf_image_slots") {
        if (String(current.document_accepted || "").toUpperCase() !== "P") {
          const error = new Error("จัดวางรูปใน PDF ได้เฉพาะกรณีรับเอกสาร (P)");
          error.status = 400;
          throw error;
        }
        const allowedStatus =
          status === "department_action" ||
          status === "qa_confirm" ||
          (status === "completed" && isQaUser(actor));
        if (!allowedStatus) {
          const error = new Error("สถานะนี้ยังไม่สามารถจัดวางรูปใน PDF ได้");
          error.status = 400;
          throw error;
        }
        if (status === "department_action" && !isResponsibleDepartmentUser(actor, current) && !isQaUser(actor)) {
          const error = new Error("ไม่มีสิทธิ์จัดวางรูปใน PDF");
          error.status = 403;
          throw error;
        }
        if ((status === "qa_confirm" || status === "completed") && !isQaUser(actor) && !isCmsAdmin(actor)) {
          const error = new Error("เฉพาะ QA ที่จัดวางรูปใน PDF ได้ในขั้นตอนนี้");
          error.status = 403;
          throw error;
        }

        const previous = normalizePlanForm(current.plan_form_json);
        const next = normalizePlanForm({
          ...previous,
          pdfImageSlots: payload.pdf_image_slots || {},
        });
        if (JSON.stringify(previous.pdfImageSlots) === JSON.stringify(next.pdfImageSlots)) {
          return { record: current, changed: false, action: "save_pdf_image_slots" };
        }
        await complaints.updatePlanFormJson(id, next);
        await activityLogs.create({
          userId: actor.id,
          username: actor.username,
          displayName: actor.display_name,
          department: actor.department,
          action: "update",
          entityType: "complaint_record",
          entityId: id,
          summary: `จัดวางรูปใน Action Plan PDF ${current.pdr_no || `#${id}`}`,
          changes: [
            {
              field: "pdf_image_slots",
              label: "ตำแหน่งรูปใน PDF",
              before: JSON.stringify(previous.pdfImageSlots || {}),
              after: JSON.stringify(next.pdfImageSlots || {}),
            },
          ],
        });
        return {
          record: await complaints.findById(id),
          changed: true,
          action: "save_pdf_image_slots",
        };
      }

      if (status === "completed") {
        const error = new Error("รายการนี้ Confirm และปิดงานแล้ว");
        error.status = 409;
        throw error;
      }
      if (!canWork(status, actor, current)) {
        const error = new Error("บัญชีนี้ไม่มีสิทธิ์กรอกข้อมูลใน Step ปัจจุบัน");
        error.status = 403;
        throw error;
      }

      // เติมช่องเอกสารอัตโนมัติถ้าว่าง (กรณีรับเรื่องก่อนมีฟีเจอร์ หรือ backend ยังไม่รีสตาร์ท)
      if (status === "department_action" && payload.action === "ensure_doc_fields") {
        if (!isResponsibleDepartmentUser(actor, current)) {
          const error = new Error(
            `เฉพาะหน่วยงานที่รับผิดชอบ (${current.responsible_department_name || "-"}) เท่านั้น`,
          );
          error.status = 403;
          throw error;
        }

        const acceptedAt =
          (await activityLogs.findDepartmentAcceptedAt(id)) ||
          current.updated_at ||
          new Date();
        const meta = resolveDepartmentDocMeta(current, actor, acceptedAt);
        const ensureUpdates = {};
        const ensureChanges = [];

        const fieldLabels = {
          doc_forward_date: "วันที่ส่งต่อเอกสาร",
          doc_receiver: "ผู้รับเอกสาร",
          doc_reply_date: "วันที่รับเอกสารตอบกลับ",
          doc_cs_sale_date: "วันที่ส่งเอกสาร CS&Sale",
          lead_time_days: "Lead time (วัน)",
        };

        for (const [key, label] of Object.entries(fieldLabels)) {
          const before = current[key];
          const after = meta[key];
          const beforeEmpty =
            before == null ||
            before === "" ||
            (key !== "lead_time_days" && !String(before).trim());
          if (!beforeEmpty) continue;
          if (after == null || after === "") continue;
          if (display(before) === display(after)) continue;
          ensureUpdates[key] = after;
          ensureChanges.push({ field: key, label, before, after });
        }

        if (!Object.keys(ensureUpdates).length) {
          return { record: current, changed: false, action: "ensure_doc_fields" };
        }

        ensureUpdates.updated_by = actor.id;
        await complaints.updateById(id, ensureUpdates);
        await activityLogs.create({
          userId: actor.id,
          username: actor.username,
          displayName: actor.display_name,
          department: actor.department,
          action: "update",
          entityType: "complaint_record",
          entityId: id,
          summary: `เติมข้อมูลเอกสารอัตโนมัติ Complaint ${current.pdr_no || `#${id}`}`,
          changes: ensureChanges.map((change) => ({
            ...change,
            before: displayChangeValue(change.field, change.before),
            after: displayChangeValue(change.field, change.after),
          })),
        });
        return {
          record: await complaints.findById(id),
          changed: true,
          action: "ensure_doc_fields",
        };
      }

      // QA/QC รับเรื่อง → CS แก้ไม่ได้แล้ว
      if (status === "pending_qa" && payload.action === "accept") {
        if (!isQaUser(actor)) {
          const error = new Error("เฉพาะ QA เท่านั้นที่รับเรื่องได้");
          error.status = 403;
          throw error;
        }
        await complaints.updateById(id, {
          workflow_status: "qa_review",
          updated_by: actor.id,
        });
        await activityLogs.create({
          userId: actor.id,
          username: actor.username,
          displayName: actor.display_name,
          department: actor.department,
          action: "accept",
          entityType: "complaint_record",
          entityId: id,
          summary: `QA รับเรื่อง Complaint ${current.pdr_no || `#${id}`}`,
          changes: [
            {
              field: "workflow_status",
              label: "สถานะ",
              before: status,
              after: "qa_review",
            },
          ],
        });
        return {
          record: await complaints.findById(id),
          changed: true,
          action: "accept",
        };
      }

      // หน่วยงานที่รับผิดชอบรับเรื่อง → QA แก้ไม่ได้แล้ว
      if (status === "pending_department" && payload.action === "accept") {
        if (!isResponsibleDepartmentUser(actor, current)) {
          const error = new Error(
            `เฉพาะหน่วยงานที่รับผิดชอบ (${current.responsible_department_name || "-"}) เท่านั้นที่รับเรื่องได้`,
          );
          error.status = 403;
          throw error;
        }

        const acceptAt = new Date();
        const meta = resolveDepartmentDocMeta(current, actor, acceptAt);

        const acceptUpdates = {
          workflow_status: "department_action",
          ...meta,
          updated_by: actor.id,
        };
        if (!acceptUpdates.doc_receiver) delete acceptUpdates.doc_receiver;

        const acceptChanges = [
          {
            field: "workflow_status",
            label: "สถานะ",
            before: status,
            after: "department_action",
          },
          {
            field: "doc_forward_date",
            label: "วันที่ส่งต่อเอกสาร",
            before: current.doc_forward_date,
            after: meta.doc_forward_date,
          },
          {
            field: "doc_receiver",
            label: "ผู้รับเอกสาร",
            before: current.doc_receiver,
            after: meta.doc_receiver,
          },
          {
            field: "doc_reply_date",
            label: "วันที่รับเอกสารตอบกลับ",
            before: current.doc_reply_date,
            after: meta.doc_reply_date,
          },
          {
            field: "doc_cs_sale_date",
            label: "วันที่ส่งเอกสาร CS&Sale",
            before: current.doc_cs_sale_date,
            after: meta.doc_cs_sale_date,
          },
          {
            field: "lead_time_days",
            label: "Lead time (วัน)",
            before: current.lead_time_days,
            after: meta.lead_time_days,
          },
        ].filter(
          (change) =>
            displayChangeValue(change.field, change.before) !==
            displayChangeValue(change.field, change.after),
        );

        await complaints.updateById(id, acceptUpdates);
        await activityLogs.create({
          userId: actor.id,
          username: actor.username,
          displayName: actor.display_name,
          department: actor.department,
          action: "accept",
          entityType: "complaint_record",
          entityId: id,
          summary: `${actor.department || "หน่วยงาน"} รับเรื่อง Complaint ${current.pdr_no || `#${id}`}`,
          changes: acceptChanges.map((change) => ({
            ...change,
            before: displayChangeValue(change.field, change.before),
            after: displayChangeValue(change.field, change.after),
          })),
        });
        return {
          record: await complaints.findById(id),
          changed: true,
          action: "accept",
        };
      }

      if (status === "qa_confirm") {
        if (payload.action !== "confirm" && payload.action !== "save") {
          const error = new Error("QA ต้องกด Confirm เพื่อจบงาน หรือบันทึกการแก้ไข");
          error.status = 400;
          throw error;
        }

        const isConfirm = payload.action === "confirm";
        const updates = {
          updated_by: actor.id,
        };
        const changes = [];

        if (isConfirm) {
          updates.workflow_status = "completed";
          updates.confirmed_by = actor.id;
          updates.confirmed_at = new Date();
          changes.push({
            field: "workflow_status",
            label: "สถานะ",
            before: status,
            after: "completed",
          });
        }

        // QA ปรับแก้สาเหตุ/แก้ไข/ป้องกัน/หมายเหตุ ได้ก่อนปิดงาน
        const qaConfirmEditable = ["cause", "correction", "prevention", "remark"];
        for (const key of qaConfirmEditable) {
          if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
          const [label, type] = COMPLAINT_FIELD_META.department[key];
          const before = normalize(type, current[key]);
          const after = normalize(type, payload[key]);
          if (before === after) continue;
          updates[key] = after;
          changes.push({ field: key, label, before, after });
        }

        let planChanged = false;
        if (
          String(current.document_accepted || "").toUpperCase() === "P" &&
          Object.prototype.hasOwnProperty.call(payload, "pdf_image_slots")
        ) {
          const previousPlan = normalizePlanForm(current.plan_form_json);
          const nextPlan = normalizePlanForm({
            ...previousPlan,
            pdfImageSlots: payload.pdf_image_slots || {},
          });
          if (
            JSON.stringify(previousPlan.pdfImageSlots) !==
            JSON.stringify(nextPlan.pdfImageSlots)
          ) {
            await complaints.updatePlanFormJson(id, nextPlan);
            planChanged = true;
            changes.push({
              field: "pdf_image_slots",
              label: "ตำแหน่งรูปใน PDF",
              before: JSON.stringify(previousPlan.pdfImageSlots || {}),
              after: JSON.stringify(nextPlan.pdfImageSlots || {}),
            });
          }
        }

        if (!isConfirm && changes.length === 0) {
          return { record: current, changed: false, action: "save" };
        }

        await complaints.updateById(id, updates);
        await activityLogs.create({
          userId: actor.id,
          username: actor.username,
          displayName: actor.display_name,
          department: actor.department,
          action: isConfirm ? "confirm" : "update",
          entityType: "complaint_record",
          entityId: id,
          summary: isConfirm
            ? `QA Confirm Complaint ${current.pdr_no || `#${id}`}`
            : `QA แก้ไขสาเหตุ/แก้ไข/ป้องกัน Complaint ${current.pdr_no || `#${id}`}`,
          changes: changes.map((change) => ({
            ...change,
            before: displayChangeValue(change.field, change.before),
            after: displayChangeValue(change.field, change.after),
          })),
        });
        return {
          record: await complaints.findById(id),
          changed: true,
          action: isConfirm ? "confirm" : "save",
        };
      }

      // หลัง QA รับเรื่องแล้ว CS ห้ามแก้
      if ((status === "cs_draft" || status === "pending_qa") && !isCsUser(actor)) {
        const error = new Error("เฉพาะ CS ที่แก้ไขข้อมูลช่วงนี้ได้ หรือ QA กดรับเรื่อง");
        error.status = 403;
        throw error;
      }

      // รอหน่วยงานรับเรื่อง — เฉพาะ QA แก้ข้อมูล QA ได้ (หน่วยงานกดรับเรื่องอย่างเดียว)
      if (status === "pending_department" && !isQaUser(actor)) {
        const error = new Error(
          "ช่วงนี้เฉพาะ QA แก้ไขได้ หรือหน่วยงานที่รับผิดชอบกดรับเรื่อง",
        );
        error.status = 403;
        throw error;
      }

      // หลังหน่วยงานรับเรื่องแล้ว — เฉพาะหน่วยงานที่รับผิดชอบกรอกได้
      if (status === "department_action" && !isResponsibleDepartmentUser(actor, current)) {
        const error = new Error(
          `เฉพาะหน่วยงานที่รับผิดชอบ (${current.responsible_department_name || "-"}) เท่านั้นที่กรอกได้`,
        );
        error.status = 403;
        throw error;
      }

      const config = STATUS_CONFIG[status];
      if (!config) {
        const error = new Error("สถานะนี้ยังไม่รองรับการแก้ไข");
        error.status = 400;
        throw error;
      }

      const fieldMeta = COMPLAINT_FIELD_META[config.group];
      const updates = {};
      const changes = [];

      for (const [key, [label, type]] of Object.entries(fieldMeta)) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
        const before =
          key === "document_accepted"
            ? normalizeDocumentAccepted(current[key])
            : key === "document_scope"
              ? normalizeDocumentScope(current[key])
              : normalize(type, current[key]);
        const after =
          key === "document_accepted"
            ? normalizeDocumentAccepted(payload[key])
            : key === "document_scope"
              ? normalizeDocumentScope(payload[key])
              : normalize(type, payload[key]);
        if (key === "document_accepted" && payload[key] != null && String(payload[key]).trim() !== "" && after == null) {
          const error = new Error("สถานะเอกสารต้องเป็น O หรือ P เท่านั้น");
          error.status = 400;
          throw error;
        }
        if (key === "document_scope" && payload[key] != null && String(payload[key]).trim() !== "" && after == null) {
          const error = new Error("เอกสารภายใน/ภายนอกต้องเป็น ภายใน หรือ ภายนอก เท่านั้น");
          error.status = 400;
          throw error;
        }
        if (before === after) continue;
        changes.push({ field: key, label, before, after });

        if (key === "company_name") {
          updates.company_id = await complaints.resolveCompanyId(after);
        } else if (key === "customer_alias_name") {
          const companyId = updates.company_id ?? current.company_id;
          updates.customer_alias_id = await complaints.resolveAliasId(companyId, after);
        } else if (key === "flute_name") {
          updates.flute_id = await complaints.resolveFluteId(after);
        } else if (key === "machine_name") {
          updates.machine_id = await complaints.resolveMachineId(after);
        } else if (key === "reported_by_department_name") {
          updates.reported_by_department_id = await complaints.resolveDepartmentId(after);
        } else if (key === "responsible_department_name") {
          updates.responsible_department_id = await complaints.resolveDepartmentId(after);
        } else if (key === "problem_name") {
          updates.problem_id = await complaints.resolveProblemId(after, payload.problem_name_en);
        } else if (key === "problem_name_en") {
          if (!Object.prototype.hasOwnProperty.call(payload, "problem_name")) {
            updates.problem_id = await complaints.resolveProblemId(current.problem_name, after);
          }
        } else {
          updates[key] = after;
        }
      }

      const isSubmit = payload.action === "submit";
      if (isSubmit) {
        const requiredKeys = REQUIRED_ON_SUBMIT[config.group] || [];
        for (const key of requiredKeys) {
          const value =
            Object.prototype.hasOwnProperty.call(updates, key)
              ? updates[key]
              : key === "problem_name"
                ? (Object.prototype.hasOwnProperty.call(updates, "problem_id")
                  ? updates.problem_id
                  : current.problem_id || current.problem_name)
                : key === "reported_by_department_name"
                  ? (Object.prototype.hasOwnProperty.call(updates, "reported_by_department_id")
                    ? updates.reported_by_department_id
                    : current.reported_by_department_id || current.reported_by_department_name)
                  : key === "responsible_department_name"
                    ? (Object.prototype.hasOwnProperty.call(updates, "responsible_department_id")
                      ? updates.responsible_department_id
                      : current.responsible_department_id || current.responsible_department_name)
                    : key === "document_accepted"
                      ? (updates.document_accepted ?? normalizeDocumentAccepted(current.document_accepted))
                      : (updates[key] ?? current[key]);
          if (value == null || value === "") {
            const label = fieldMeta[key]?.[0] || key;
            const error = new Error(`กรุณากรอก${label}`);
            error.status = 400;
            throw error;
          }
        }

        let nextStatus = config.next;
        let qaDocumentAccepted = null;
        if (status === "qa_review" || status === "pending_department") {
          qaDocumentAccepted =
            updates.document_accepted ?? normalizeDocumentAccepted(current.document_accepted);
          if (qaDocumentAccepted === "P") {
            for (const key of QA_REQUIRED_WHEN_P) {
              const value =
                Object.prototype.hasOwnProperty.call(updates, key)
                  ? updates[key]
                  : current[key];
              if (value == null || value === "") {
                const label = fieldMeta[key]?.[0] || key;
                const error = new Error(`กรุณากรอก${label}`);
                error.status = 400;
                throw error;
              }
            }
          }
          nextStatus = resolveQaNextStatus(qaDocumentAccepted);
        }
        if (nextStatus !== status) {
          updates.workflow_status = nextStatus;
          changes.push({
            field: "workflow_status",
            label: "สถานะ",
            before: status,
            after: nextStatus,
          });
        }
        updates[config.submittedBy] = actor.id;
        updates[config.submittedAt] = new Date();

        // วันที่ส่งต่อเอกสาร = วันสุดท้ายที่ QA กด Submit (อัปเดตได้จนกว่าหน่วยงานจะรับเรื่อง)
        if (
          (status === "qa_review" || status === "pending_department") &&
          qaDocumentAccepted === "P"
        ) {
          const forwardDate = toLocalDateOnly(updates[config.submittedAt]);
          const beforeForward = toDateOnly(current.doc_forward_date);
          if (beforeForward !== forwardDate) {
            changes.push({
              field: "doc_forward_date",
              label: "วันที่ส่งต่อเอกสาร",
              before: beforeForward,
              after: forwardDate,
            });
          }
          updates.doc_forward_date = forwardDate;
        }
      }

      if (!Object.keys(updates).length) {
        return { record: current, changed: false, action: null };
      }
      updates.updated_by = actor.id;
      await complaints.updateById(id, updates);

      const action = isSubmit ? "submit" : "update";
      await activityLogs.create({
        userId: actor.id,
        username: actor.username,
        displayName: actor.display_name,
        department: actor.department,
        action,
        entityType: "complaint_record",
        entityId: id,
        summary: `${isSubmit ? "ส่งต่อ" : "บันทึก"} Complaint ${current.pdr_no || `#${id}`} (${changes.length} รายการ)`,
        changes: changes.map((change) => ({
          ...change,
          before: displayChangeValue(change.field, change.before),
          after: displayChangeValue(change.field, change.after),
        })),
      });

      return {
        record: await complaints.findById(id),
        changed: true,
        action,
      };
    },
  };
}
