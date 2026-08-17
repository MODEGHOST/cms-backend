/**
 * Import Complaint Excel → complaint_records
 * Default: only sheet "2026" from ทะเบียนข้อร้องเรียน.xlsx
 *
 * Usage:
 *   npm run db:import-complaint
 *   npm run db:import-complaint -- "c:/path/to/file.xlsx"
 *   npm run db:import-complaint -- "c:/path/to/file.xlsx" 2026
 */
import "../src/core/load-env.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import XLSX from "xlsx";
import { createPool } from "../src/core/db.js";
import { logger } from "../src/core/logger.js";
import { canonicalizeDepartmentName, isCanonicalDepartment } from "../src/utils/department-map.js";

const DEFAULT_EXCEL = "c:/Users/sa.data02/Downloads/ทะเบียนข้อร้องเรียน.xlsx";
const DEFAULT_SHEET = "2026";

/** Column index order matching Excel header row (row 2). */
const COL = {
  excel_seq: 0,
  pdr_no: 1,
  order_no: 2,
  company: 3,
  alias: 4,
  product_name: 5,
  flute: 6,
  paper_m5: 7,
  paper_m4: 8,
  paper_m3: 9,
  paper_m2: 10,
  paper_m1: 11,
  delivery_date: 12,
  demand_qty: 13,
  production_date: 14,
  plan_no: 15,
  machine: 16,
  shift: 17,
  received_date: 18,
  // 19 = เดือน (derived — skip)
  problem_th: 20,
  problem_en: 21,
  sale_cs_staff: 22,
  grade: 23,
  reported_by: 24,
  responsible: 25,
  ng_qty: 26,
  document_accepted: 27,
  document_scope: 28,
  document_no: 29,
  doc_forward_date: 30,
  doc_receiver: 31,
  doc_reply_date: 32,
  doc_cs_sale_date: 33,
  lead_time_days: 34,
  cause: 35,
  correction: 36,
  prevention: 37,
  completed_date: 38,
  remark: 39,
};

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
  if (a > 12 && b <= 12) {
    day = a;
    month = b;
  } else if (b > 12 && a <= 12) {
    day = b;
    month = a;
  } else {
    // Prefer D/M/Y (Thai sheets); some cells are M/D/Y like US Excel
    day = a;
    month = b;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const check = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(check.getTime())) return null;
  return iso;
}

function cell(row, index) {
  return row?.[index] ?? null;
}

function pickDate(rawRow, textRow, index) {
  return parseDate(cell(rawRow, index)) || parseDate(cell(textRow, index));
}

function parseDocumentAccepted(value) {
  const text = cleanText(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === "P" || upper === "O") return upper;
  return null;
}

function parseDocumentScope(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (text === "ภายใน" || text === "ภายนอก") return text;
  return null;
}

async function upsertMaster(conn, table, name) {
  const clean =
    table === "departments" ? canonicalizeDepartmentName(name) : cleanText(name);
  if (!clean) return null;
  if (table === "departments") {
    const [[existing]] = await conn.query(
      `SELECT id FROM departments
       WHERE LOWER(name) = LOWER(?)
       ORDER BY is_active DESC, id ASC
       LIMIT 1`,
      [clean],
    );
    if (existing?.id) {
      await conn.query(`UPDATE departments SET is_active = 1, name = ? WHERE id = ?`, [
        clean,
        existing.id,
      ]);
      return existing.id;
    }
    // ห้ามสร้างแผนกนอก Master จาก Excel เก่า
    if (!isCanonicalDepartment(clean)) {
      logger.warn(`Skip unknown department from Excel: ${JSON.stringify(name)} → ${JSON.stringify(clean)}`);
      return null;
    }
    await conn.query(`INSERT INTO departments (name, is_active) VALUES (?, 1)`, [
      clean,
    ]);
    const [[row]] = await conn.query(
      `SELECT id FROM departments WHERE LOWER(name) = LOWER(?) LIMIT 1`,
      [clean],
    );
    return row?.id ?? null;
  }
  await conn.query(
    `INSERT INTO ${table} (name, is_active) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE is_active = VALUES(is_active)`,
    [clean],
  );
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE name = ? LIMIT 1`, [clean]);
  return row?.id ?? null;
}

async function upsertCompany(conn, name, nameEn) {
  const clean = cleanText(name);
  if (!clean) return null;
  const english = cleanText(nameEn);
  await conn.query(
    `INSERT INTO companies (name, name_en, is_active) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
       name_en = COALESCE(VALUES(name_en), name_en),
       is_active = 1`,
    [clean, english],
  );
  const [[row]] = await conn.query(`SELECT id FROM companies WHERE name = ? LIMIT 1`, [clean]);
  return row?.id ?? null;
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

async function upsertProblem(conn, nameTh, nameEn) {
  const th = cleanText(nameTh);
  const en = cleanText(nameEn);
  if (!th) return null;

  await conn.query(
    `INSERT INTO problems (name, name_en, is_active) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
       name_en = COALESCE(VALUES(name_en), name_en),
       is_active = 1`,
    [th, en],
  );
  const [[row]] = await conn.query(`SELECT id FROM problems WHERE name = ? LIMIT 1`, [th]);
  return row?.id ?? null;
}

function mapRow(rawRow, textRow) {
  const text = textRow || rawRow;
  const paperZeroToNull = (v) => {
    const t = cleanText(v);
    if (!t || t === "0") return null;
    return t;
  };

  return {
    excel_seq: parseNumber(cell(text, COL.excel_seq)),
    companyName: cleanText(cell(text, COL.company)),
    aliasName: cleanText(cell(text, COL.alias)),
    fluteName: cleanText(cell(text, COL.flute)),
    machineName: cleanText(cell(text, COL.machine)),
    problemTh: cleanText(cell(text, COL.problem_th)),
    problemEn: cleanText(cell(text, COL.problem_en)),
    reportedByName: cleanText(cell(text, COL.reported_by)),
    responsibleName: cleanText(cell(text, COL.responsible)),

    pdr_no: cleanText(cell(text, COL.pdr_no)),
    order_no: cleanText(cell(text, COL.order_no)),
    product_name: cleanText(cell(text, COL.product_name)),
    paper_m5: paperZeroToNull(cell(text, COL.paper_m5)),
    paper_m4: paperZeroToNull(cell(text, COL.paper_m4)),
    paper_m3: paperZeroToNull(cell(text, COL.paper_m3)),
    paper_m2: paperZeroToNull(cell(text, COL.paper_m2)),
    paper_m1: paperZeroToNull(cell(text, COL.paper_m1)),
    plan_no: cleanText(cell(text, COL.plan_no)),
    shift: cleanText(cell(text, COL.shift)),

    delivery_date: pickDate(rawRow, text, COL.delivery_date),
    production_date: pickDate(rawRow, text, COL.production_date),
    received_date: pickDate(rawRow, text, COL.received_date),
    completed_date: pickDate(rawRow, text, COL.completed_date),

    demand_qty: parseNumber(cell(text, COL.demand_qty)),
    ng_qty: parseNumber(cell(text, COL.ng_qty)),
    grade: cleanText(cell(text, COL.grade)),
    sale_cs_staff: cleanText(cell(text, COL.sale_cs_staff)),

    document_accepted: parseDocumentAccepted(cell(text, COL.document_accepted)),
    document_scope: parseDocumentScope(cell(text, COL.document_scope)),
    document_no: cleanText(cell(text, COL.document_no)),
    doc_forward_date: pickDate(rawRow, text, COL.doc_forward_date),
    doc_receiver: cleanText(cell(text, COL.doc_receiver)),
    doc_reply_date: pickDate(rawRow, text, COL.doc_reply_date),
    doc_cs_sale_date: pickDate(rawRow, text, COL.doc_cs_sale_date),
    lead_time_days: parseNumber(cell(text, COL.lead_time_days)),

    cause: cleanText(cell(text, COL.cause)),
    correction: cleanText(cell(text, COL.correction)),
    prevention: cleanText(cell(text, COL.prevention)),
    remark: cleanText(cell(text, COL.remark)),
  };
}

function findSheetName(wb, wanted) {
  const target = String(wanted).trim().toLowerCase();
  return wb.SheetNames.find((name) => String(name).trim().toLowerCase() === target) || null;
}

function resolveSheetNames(wb, sheetWanted) {
  const wanted = String(sheetWanted || "").trim().toLowerCase();
  if (!wanted || wanted === "all" || wanted === "*") {
    return wb.SheetNames.filter((name) => /^\s*\d{4}\s*$/.test(String(name)));
  }
  const one = findSheetName(wb, sheetWanted);
  return one ? [one] : [];
}

async function importSheet(conn, sheet, sheetName) {
  const textMatrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });
  const rawMatrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
  });

  let imported = 0;
  let skipped = 0;

  // Row 0 = title, row 1 = headers, data starts at row 2
  for (let i = 2; i < textMatrix.length; i += 1) {
    const textRow = textMatrix[i];
    const rawRow = rawMatrix[i] || textRow;
    if (!Array.isArray(textRow) || !textRow.some((v) => cleanText(v))) {
      skipped += 1;
      continue;
    }

    const row = mapRow(rawRow, textRow);
    if (!row.problemTh && !row.companyName && !row.received_date) {
      skipped += 1;
      continue;
    }

    const companyId = await upsertCompany(conn, row.companyName, row.aliasName);
    const aliasId = await upsertAlias(conn, companyId, row.aliasName);
    const fluteId = await upsertMaster(conn, "flutes", row.fluteName);
    const machineId = await upsertMaster(conn, "machines", row.machineName);
    const problemId = await upsertProblem(conn, row.problemTh, row.problemEn);
    const reportedById = await upsertMaster(conn, "departments", row.reportedByName);
    const responsibleId = await upsertMaster(conn, "departments", row.responsibleName);

    if (row.shift && ["A", "B", "C"].includes(row.shift)) {
      await upsertMaster(conn, "shifts", row.shift);
    }

    await conn.query(
      `INSERT INTO complaint_records (
        excel_seq,
        company_id, customer_alias_id, flute_id, machine_id, problem_id,
        reported_by_department_id, responsible_department_id,
        pdr_no, order_no, product_name,
        paper_m5, paper_m4, paper_m3, paper_m2, paper_m1,
        plan_no, shift,
        delivery_date, production_date, received_date, completed_date,
        demand_qty, ng_qty, grade, sale_cs_staff,
        document_accepted, document_scope, document_no,
        doc_forward_date, doc_receiver, doc_reply_date, doc_cs_sale_date, lead_time_days,
        cause, correction, prevention, remark,
        workflow_status, confirmed_at
      ) VALUES (
        ?,
        ?,?,?,?,?,
        ?,?,
        ?,?,?,
        ?,?,?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,?,?,
        ?,?,?,
        ?,?,?,?,?,
        ?,?,?,?,
        'completed', ?
      )`,
      [
        row.excel_seq,
        companyId, aliasId, fluteId, machineId, problemId,
        reportedById, responsibleId,
        row.pdr_no, row.order_no, row.product_name,
        row.paper_m5, row.paper_m4, row.paper_m3, row.paper_m2, row.paper_m1,
        row.plan_no, row.shift,
        row.delivery_date, row.production_date, row.received_date,
        row.completed_date || row.received_date || row.doc_reply_date || null,
        row.demand_qty, row.ng_qty, row.grade, row.sale_cs_staff,
        row.document_accepted, row.document_scope, row.document_no,
        row.doc_forward_date, row.doc_receiver, row.doc_reply_date, row.doc_cs_sale_date, row.lead_time_days,
        row.cause, row.correction, row.prevention, row.remark,
        // Excel เก่า = เคสที่ปิดแล้วในทะเบียน
        row.completed_date || row.received_date || row.doc_reply_date || null,
      ],
    );
    imported += 1;
  }

  logger.info(
    `Complaint sheet ${JSON.stringify(sheetName)}: imported=${imported} skipped=${skipped}`,
  );
  return { imported, skipped };
}

async function main() {
  const excelPath = resolve(process.argv[2] || DEFAULT_EXCEL);
  const sheetWanted = process.argv[3] || "all";

  const buffer = await readFile(excelPath);
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetNames = resolveSheetNames(wb, sheetWanted);
  if (!sheetNames.length) {
    throw new Error(
      `ไม่พบ sheet "${sheetWanted}" ในไฟล์ (มี: ${wb.SheetNames.map((s) => JSON.stringify(s)).join(", ")})`,
    );
  }

  const pool = createPool();
  const conn = await pool.getConnection();
  let imported = 0;
  let skipped = 0;

  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM complaint_attachments");
    await conn.query("DELETE FROM complaint_records");

    for (const sheetName of sheetNames) {
      const result = await importSheet(conn, wb.Sheets[sheetName], sheetName);
      imported += result.imported;
      skipped += result.skipped;
    }

    await conn.commit();
    logger.info(
      `Complaint import done: sheets=${JSON.stringify(sheetNames)} imported=${imported} skipped=${skipped} file=${excelPath}`,
    );
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
