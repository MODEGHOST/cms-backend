import { toDateOnly } from "../validators/common.js";
import { parseShipQty } from "../utils/parse-ship-qty.js";
import {
  joinProblemNames,
  parseProblemNames,
  problemNamesOf,
} from "../utils/problem-names.js";
import { replaceProblemsSafe, updateRecordFields } from "../repositories/record-problems.js";

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
  claim_weight_kg: { label: "รวมน้ำหนักเคลม (KG)/Order", type: "number" },
  claim_amount: { label: "จำนวนเงิน", type: "number" },
  sort_claim_sup_qty: { label: "คัดเคลม SUP", type: "number" },
  sort_weight_kg: { label: "น้ำหนัก KG", type: "number" },
  return_to_customer_qty: { label: "คัดส่งคืนลูกค้า", type: "number" },
  return_amount: { label: "จำนวนเงินที่ส่งคืนลูกค้า", type: "number" },
  return_kg: { label: "จำนวน KG", type: "number" },
  destroy_bl_qty: { label: "จำนวนแผ่นทำลาย BL", type: "number" },
  destroy_bl_weight: { label: "น้ำหนักทำลาย BL", type: "number" },
  destroy_bl_amount: { label: "จำนวนเงินทำลาย BL", type: "number" },
  remark: { label: "หมายเหตุ", type: "text" },
};

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundCalc(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** claim_weight_kg = แผ่นเล็ก × น้ำหนัก/แผ่น · claim_amount = แผ่นเล็ก × ราคา/แผ่นเล็ก */
function applyClaimTotals(updateFields, current, payload) {
  const claimQty = Object.prototype.hasOwnProperty.call(updateFields, "claim_sheet_qty")
    ? updateFields.claim_sheet_qty
    : Object.prototype.hasOwnProperty.call(payload, "claim_sheet_qty")
      ? toFiniteNumber(payload.claim_sheet_qty)
      : toFiniteNumber(current.claim_sheet_qty);

  const weightPerSheet = toFiniteNumber(current.weight_per_sheet);
  const pricePerSheet = toFiniteNumber(current.price_per_sheet);

  if (claimQty == null) {
    if (Object.prototype.hasOwnProperty.call(payload, "claim_sheet_qty")) {
      updateFields.claim_weight_kg = null;
      updateFields.claim_amount = null;
    }
    return;
  }

  if (weightPerSheet != null) {
    updateFields.claim_weight_kg = roundCalc(claimQty * weightPerSheet);
  }
  if (pricePerSheet != null) {
    updateFields.claim_amount = roundCalc(claimQty * pricePerSheet);
  }
}

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
    /**
     * CS แปลง Complaint → Reject: สร้างคิวเบาๆ ส่ง PDR ให้ QC
     * ไม่ดึง ERP ตอนนี้ — QC ค่อย GET ERP ตอนเปิดฟอร์ม / บันทึก
     */
    async createStubFromComplaint(complaint, actor) {
      if (!complaint?.id) {
        const err = new Error("ไม่พบข้อมูล Complaint");
        err.status = 400;
        throw err;
      }

      const pdrNo = String(complaint.pdr_no || "").trim();
      if (!pdrNo) {
        const err = new Error("Complaint นี้ยังไม่มีเลข PDR จึงสร้าง Reject ไม่ได้");
        err.status = 400;
        throw err;
      }

      const existing = await rejects.findBySourceComplaintId(complaint.id);
      if (existing) {
        return { record: existing, created: false };
      }

      const insertId = await rejects.createStub({
        pdrNo,
        companyId: complaint.company_id || null,
        customerAliasId: complaint.customer_alias_id || null,
        machineId: complaint.machine_id || null,
        fluteId: complaint.flute_id || null,
        problemId:
          complaint.problems?.[0]?.id || complaint.problem_id || null,
        departmentId: complaint.responsible_department_id || null,
        shift: complaint.shift || null,
        productionDate: toDateOnly(complaint.production_date),
        sourceComplaintId: complaint.id,
        createdBy: actor?.id || null,
        remark: `สร้างจาก Complaint โดย CS (${actor?.display_name || actor?.username || "-"})`,
      });

      const problemIds = (complaint.problems || [])
        .map((row) => Number(row?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!problemIds.length && complaint.problem_id) {
        problemIds.push(Number(complaint.problem_id));
      }
      if (problemIds.length) {
        await rejects.replaceProblems(insertId, problemIds);
      }

      await activityLogs.create({
        userId: actor?.id || null,
        username: actor?.username || null,
        displayName: actor?.display_name || null,
        department: actor?.department || null,
        action: "create",
        entityType: "reject_record",
        entityId: insertId,
        summary: `CS ส่ง Reject จาก Complaint ${pdrNo}`,
        changes: [
          {
            field: "source",
            label: "แหล่งที่มา",
            before: "(ว่าง)",
            after: "complaint",
          },
          {
            field: "source_complaint_id",
            label: "Complaint ID",
            before: "(ว่าง)",
            after: String(complaint.id),
          },
        ],
      });

      const record = await rejects.findById(insertId);
      return { record, created: true };
    },

    /**
     * QC ตีกลับรายการที่มาจาก Complaint — ลบออกจากคิว Reject
     * Complaint ยังอยู่ตามปกติ CS ส่งซ่อมมาใหม่ได้
     */
    async returnToCs(id, reason, actor) {
      const current = await rejects.findById(id);
      if (!current) {
        const err = new Error("ไม่พบรายการ Reject");
        err.status = 404;
        throw err;
      }
      if (current.source !== "complaint" || !current.source_complaint_id) {
        const err = new Error("ตีกลับได้เฉพาะรายการที่ CS ส่งมาจาก Complaint");
        err.status = 400;
        throw err;
      }

      const note = String(reason || "").trim();
      if (!note) {
        const err = new Error("กรุณาระบุเหตุผลที่ตีกลับ");
        err.status = 400;
        throw err;
      }

      const pdr = current.pdr_no || `#${id}`;
      await activityLogs.create({
        userId: actor?.id || null,
        username: actor?.username || null,
        displayName: actor?.display_name || null,
        department: actor?.department || null,
        action: "return",
        entityType: "reject_record",
        entityId: id,
        summary: `QC ตีกลับ Reject ${pdr} ไป CS`,
        changes: [
          {
            field: "return_reason",
            label: "เหตุผลที่ตีกลับ",
            before: "(ว่าง)",
            after: note,
          },
          {
            field: "source_complaint_id",
            label: "Complaint ID",
            before: String(current.source_complaint_id),
            after: "(ลบรายการ Reject)",
          },
        ],
      });

      await rejects.deleteById(id);
      return { record: current, reason: note };
    },

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
      const parsedProblemNames = parseProblemNames(payload);
      let nextProblemIds = null;

      for (const [key, meta] of Object.entries(QC_FIELD_META)) {
        // คำนวณจาก claim_sheet_qty × น้ำหนัก/ราคา ฝั่งเซิร์ฟเวอร์ — ไม่รับค่าจาก client โดยตรง
        if (key === "claim_weight_kg" || key === "claim_amount") continue;
        if (key === "problem_name") {
          if (parsedProblemNames == null) continue;
          const before = joinProblemNames(problemNamesOf(current));
          const after = joinProblemNames(parsedProblemNames);
          nextProblemIds = await rejects.resolveProblemIds(parsedProblemNames);
          updateFields.problem_names_json = JSON.stringify(parsedProblemNames);
          updateFields.problem_id = nextProblemIds[0] || null;
          if (before === after) continue;
          if (!before && after) touchedEmpty = true;
          changes.push({
            field: key,
            label: meta.label,
            before,
            after,
          });
          continue;
        }
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
        } else if (meta.type === "date") {
          updateFields[key] = after;
        } else if (meta.type === "number" || meta.type === "shipQty") {
          updateFields[key] = after;
        } else {
          updateFields[key] = after;
        }
      }

      // คำนวณเมื่อมีการอัปเดตจำนวนเคลม (หรือส่ง claim_sheet_qty มา)
      if (
        Object.prototype.hasOwnProperty.call(updateFields, "claim_sheet_qty") ||
        Object.prototype.hasOwnProperty.call(payload, "claim_sheet_qty")
      ) {
        applyClaimTotals(updateFields, current, payload);
        for (const key of ["claim_weight_kg", "claim_amount"]) {
          if (!Object.prototype.hasOwnProperty.call(updateFields, key)) continue;
          const meta = QC_FIELD_META[key];
          const before = normalizeForCompare(meta, current[key]);
          const after = normalizeForCompare(meta, updateFields[key]);
          if (before === after) {
            delete updateFields[key];
            continue;
          }
          if (before == null && after != null) touchedEmpty = true;
          changes.push({
            field: key,
            label: meta.label,
            before,
            after,
          });
        }
      }

      if (!changes.length) {
        if (Object.keys(updateFields).length) {
          updateFields.updated_by = actor?.id || null;
          await updateRecordFields(rejects.updateById.bind(rejects), id, updateFields);
          if (nextProblemIds != null) {
            await replaceProblemsSafe(rejects.replaceProblems.bind(rejects), id, nextProblemIds);
          }
          const record = await rejects.findById(id);
          return { record, changed: true, action: "update" };
        }
        return { record: current, changed: false };
      }

      updateFields.updated_by = actor?.id || null;
      await updateRecordFields(rejects.updateById.bind(rejects), id, updateFields);
      if (nextProblemIds != null) {
        await replaceProblemsSafe(rejects.replaceProblems.bind(rejects), id, nextProblemIds);
      }

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
