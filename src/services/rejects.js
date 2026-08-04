import { toDateOnly } from "../validators/common.js";
import { parseShipQty } from "../utils/parse-ship-qty.js";

export const QC_FIELD_META = {
  doc_notify_date: { label: "วันที่แจ้งเอกสาร", type: "date" },
  reject_received_date: { label: "รับ Reject", type: "date" },
  invoice_no: { label: "Invoice", type: "text" },
  department_name: { label: "หน่วยงานที่รับผิดชอบ", type: "master" },
  problem_name: { label: "ปัญหา", type: "master" },
  cause: { label: "สาเหตุ", type: "text" },
  job_type: { label: "ลักษณะงาน", type: "text" },
  actual_ship_qty: { label: "ยอดส่งจริง", type: "shipQty" },
  claim_sheet_qty: { label: "ลูกค้าเคลมจำนวน (แผ่นเล็ก)", type: "number" },
  return_to_customer_qty: { label: "คัดส่งคืนลูกค้า", type: "number" },
  return_amount: { label: "จำนวนเงินที่ส่งคืนลูกค้า", type: "number" },
  return_kg: { label: "จำนวน KG", type: "number" },
  destroy_bl_qty: { label: "จำนวนแผ่นทำลาย BL", type: "number" },
  destroy_bl_weight: { label: "น้ำหนักทำลาย BL", type: "number" },
  destroy_bl_amount: { label: "จำนวนเงินทำลาย BL", type: "number" },
  remark: { label: "หมายเหตุ", type: "text" },
};

function emptyToNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function normalizeForCompare(meta, value) {
  if (value == null || value === "") return null;
  if (meta.type === "date") return toDateOnly(value);
  if (meta.type === "shipQty") return parseShipQty(value);
  if (meta.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value).trim();
}

function displayLogValue(value) {
  if (value == null || value === "") return "(ว่าง)";
  return String(value);
}

export function createRejectService(pool, rejects, activityLogs) {
  return {
    async updateQcFields(id, payload, actor) {
      const current = await rejects.findById(id);
      if (!current) {
        const err = new Error("ไม่พบรายการ Reject");
        err.status = 404;
        throw err;
      }

      const updateFields = {};
      const changes = [];
      let touchedEmpty = false;

      for (const [key, meta] of Object.entries(QC_FIELD_META)) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;

        const nextRaw = emptyToNull(payload[key]);
        if (
          meta.type === "shipQty" &&
          nextRaw != null &&
          parseShipQty(nextRaw) == null
        ) {
          const err = new Error(
            "ยอดส่งจริงต้องเป็นตัวเลข หรือรูปแบบ เช่น 250*3",
          );
          err.status = 400;
          throw err;
        }

        const before = normalizeForCompare(meta, current[key]);
        const after = normalizeForCompare(meta, nextRaw);

        if (before === after) continue;
        if (before == null && after != null) touchedEmpty = true;

        changes.push({
          field: key,
          label: meta.label,
          before: before,
          after: after,
        });

        if (key === "department_name") {
          updateFields.department_id = after
            ? await rejects.resolveDepartmentId(after)
            : null;
        } else if (key === "problem_name") {
          updateFields.problem_id = after
            ? await rejects.resolveProblemId(after)
            : null;
        } else if (meta.type === "date") {
          updateFields[key] = after;
        } else if (meta.type === "number" || meta.type === "shipQty") {
          updateFields[key] = after;
        } else {
          updateFields[key] = after;
        }
      }

      if (!changes.length) {
        return { record: current, changed: false };
      }

      updateFields.updated_by = actor?.id || null;
      await rejects.updateById(id, updateFields);

      const action = current.updated_by == null && touchedEmpty ? "fill" : "update";
      const actionLabel = action === "fill" ? "กรอกฟอร์ม" : "อัปเดตแก้ไข";
      const pdr = current.pdr_no || `#${id}`;
      const summary = `${actionLabel} Reject ${pdr} (${changes.length} ช่อง)`;

      await activityLogs.create({
        userId: actor?.id || null,
        username: actor?.username || null,
        displayName: actor?.display_name || null,
        department: actor?.department || null,
        action,
        entityType: "reject_record",
        entityId: id,
        summary,
        changes: changes.map((item) => ({
          field: item.field,
          label: item.label,
          before: displayLogValue(item.before),
          after: displayLogValue(item.after),
        })),
      });

      const record = await rejects.findById(id);
      return { record, changed: true, action, changes };
    },
  };
}
