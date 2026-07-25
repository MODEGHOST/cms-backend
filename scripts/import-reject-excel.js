import "../src/core/load-env.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import XLSX from "xlsx";
import { createPool } from "../src/core/db.js";
import { logger } from "../src/core/logger.js";

const DEFAULT_EXCEL = "c:/Users/sa.data02/Downloads/Data reject.xlsx";

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text === "-" || text === "null") return null;
  return text;
}

function parseNumber(value) {
  const text = cleanText(value);
  if (!text) return null;
  const normalized = text.replace(/,/g, "").replace(/\*/g, "").trim();
  if (!normalized || normalized === "-") return null;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

/**
 * Convert Excel date to calendar YYYY-MM-DD.
 * Prefer real Excel Date values (same as Excel AutoFilter).
 * xlsx often yields previous-day 23:59:56 in GMT+7 — nudge forward slightly.
 */
function fromExcelDateObject(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  const shifted = new Date(value.getTime() + 10 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, "0");
  const d = String(shifted.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDate(value) {
  if (value == null || value === "") return null;

  const fromObject = fromExcelDateObject(value);
  if (fromObject) return fromObject;

  const text = cleanText(value);
  if (!text) return null;

  // Excel serial number
  if (/^\d+(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const utc = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
      return fromExcelDateObject(utc) || utc.toISOString().slice(0, 10);
    }
  }

  const m = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;

  let day;
  let month;
  // Unambiguous:
  if (a > 12 && b <= 12) {
    day = a;
    month = b; // D/M/Y
  } else if (b > 12 && a <= 12) {
    day = b;
    month = a; // M/D/Y
  } else {
    // Ambiguous text without Date object: prefer D/M/Y (Thai display like 01/07/2026)
    day = a;
    month = b;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(check.getTime())) return null;
  return iso;
}

function pickDate(rawRow, textRow, key) {
  return parseDate(rawRow?.[key]) || parseDate(textRow?.[key]);
}

async function upsertMaster(conn, table, name) {
  const clean = cleanText(name);
  if (!clean) return null;
  await conn.query(
    `INSERT INTO ${table} (name, is_active) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)`,
    [clean],
  );
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE name = ? LIMIT 1`, [clean]);
  return row?.id ?? null;
}

async function upsertCompany(conn, name) {
  return upsertMaster(conn, "companies", name);
}

async function upsertAlias(conn, companyId, name) {
  const clean = cleanText(name);
  if (!clean || !companyId) return null;
  await conn.query(
    `INSERT INTO customer_aliases (company_id, name, is_active)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)`,
    [companyId, clean],
  );
  const [[row]] = await conn.query(
    `SELECT id FROM customer_aliases WHERE company_id = ? AND name = ? LIMIT 1`,
    [companyId, clean],
  );
  return row?.id ?? null;
}

function mapRow(rawRow, textRow) {
  const text = textRow || rawRow;
  return {
    companyName: cleanText(text["ชื่อเต็มลูกค้า"]),
    aliasName: cleanText(text["ชื่อลูกค้า"]),
    departmentName: cleanText(text["หน่วยงานที่รับผิดชอบ"]),
    machineName: cleanText(text["เครื่อง"]),
    problemName: cleanText(text["ปัญหา"]),
    doc_notify_date: pickDate(rawRow, text, "วันที่แจ้งเอกสาร"),
    reject_received_date: pickDate(rawRow, text, "รับ Reject"),
    customer_ship_date: pickDate(rawRow, text, "วันที่ส่งลูกค้า"),
    production_date: pickDate(rawRow, text, "วันที่ผลิต"),
    repair_date: pickDate(rawRow, text, "วันที่ซ่อม"),
    invoice_no: cleanText(text["INVOICE"]),
    pdr_no: cleanText(text["PDR"]),
    sale_order_no: cleanText(text["Sale Order"]),
    order_qty: parseNumber(text["Order"]),
    size: cleanText(text["Size"]),
    shift: cleanText(text["กะ"]),
    job_type: cleanText(text["ลักษณะงาน"]),
    vehicle_plate: cleanText(text["ทะเบียน"]),
    cause: cleanText(text["สาเหตุ"]),
    remark: cleanText(text["หมายเหตุ"]),
    actual_ship_qty: parseNumber(text[" ยอดส่งจริง "] ?? text["ยอดส่งจริง"]),
    claim_sheet_qty: parseNumber(text[" ลูกค้าเคลมจำนวน  (แผ่นเล็ก) "] ?? text["ลูกค้าเคลมจำนวน  (แผ่นเล็ก)"]),
    weight_per_sheet: parseNumber(text[" น้ำหนัก/แผ่น "] ?? text["น้ำหนัก/แผ่น"]),
    claim_weight_kg: parseNumber(text[" รวมน้ำหนักเคลม ( KG )/ORDER "] ?? text["รวมน้ำหนักเคลม ( KG )/ORDER"]),
    price_per_sheet: parseNumber(text[" ราคา/แผ่นเล็ก "] ?? text["ราคา/แผ่นเล็ก"]),
    claim_amount: parseNumber(text[" จำนวนเงิน "] ?? text["จำนวนเงิน"]),
    sort_claim_sup_qty: parseNumber(text["คัดเคลม SUP"]),
    sort_weight_kg: parseNumber(text["น้ำหนัก KG"]),
    return_to_customer_qty: parseNumber(text["คัดส่งคืนลูกค้า"]),
    return_amount: parseNumber(text["จำนวนเงินที่ส่งคืน ลูกค้า"]),
    return_kg: parseNumber(text["จำนวน KG"]),
    destroy_bl_qty: parseNumber(text["จำนวนแผ่นทำลาย BL"]),
    destroy_bl_weight: parseNumber(text["น้ำหนักทำลาย BL"]),
    destroy_bl_amount: parseNumber(text["จำนวนเงินทำลาย BL"]),
  };
}

async function main() {
  const excelPath = resolve(process.argv[2] || DEFAULT_EXCEL);
  const buffer = await readFile(excelPath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const textRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });

  const pool = createPool();
  const conn = await pool.getConnection();
  let imported = 0;
  let skipped = 0;

  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM reject_records");

    for (let i = 0; i < textRows.length; i += 1) {
      const row = mapRow(rawRows[i], textRows[i]);
      if (!row.problemName && !row.companyName && !row.reject_received_date) {
        skipped += 1;
        continue;
      }

      const companyId = await upsertCompany(conn, row.companyName);
      const aliasId = await upsertAlias(conn, companyId, row.aliasName);
      const departmentId = await upsertMaster(conn, "departments", row.departmentName);
      const machineId = await upsertMaster(conn, "machines", row.machineName);
      const problemId = await upsertMaster(conn, "problems", row.problemName);
      if (row.shift === "A" || row.shift === "B") {
        await upsertMaster(conn, "shifts", row.shift);
      }

      await conn.query(
        `INSERT INTO reject_records (
          company_id, customer_alias_id, department_id, machine_id, problem_id,
          doc_notify_date, reject_received_date, customer_ship_date, production_date, repair_date,
          invoice_no, pdr_no, sale_order_no, order_qty, size, shift, job_type, vehicle_plate, cause, remark,
          actual_ship_qty, claim_sheet_qty, weight_per_sheet, claim_weight_kg, price_per_sheet, claim_amount,
          sort_claim_sup_qty, sort_weight_kg, return_to_customer_qty, return_amount, return_kg,
          destroy_bl_qty, destroy_bl_weight, destroy_bl_amount
        ) VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?)`,
        [
          companyId, aliasId, departmentId, machineId, problemId,
          row.doc_notify_date, row.reject_received_date, row.customer_ship_date, row.production_date, row.repair_date,
          row.invoice_no, row.pdr_no, row.sale_order_no, row.order_qty, row.size, row.shift, row.job_type, row.vehicle_plate, row.cause, row.remark,
          row.actual_ship_qty, row.claim_sheet_qty, row.weight_per_sheet, row.claim_weight_kg, row.price_per_sheet, row.claim_amount,
          row.sort_claim_sup_qty, row.sort_weight_kg, row.return_to_customer_qty, row.return_amount, row.return_kg,
          row.destroy_bl_qty, row.destroy_bl_weight, row.destroy_bl_amount,
        ],
      );
      imported += 1;
    }

    await conn.commit();
    logger.info(`Import done: imported=${imported} skipped=${skipped} file=${excelPath}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
