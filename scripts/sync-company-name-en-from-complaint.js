/**
 * Replace companies.name_en using only the Complaint Excel "Customer" column.
 * Does not read or update customer_aliases.
 */
import "../src/core/load-env.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import XLSX from "xlsx";
import { createPool } from "../src/core/db.js";

const DEFAULT_EXCEL = "c:/Users/sa.data02/Downloads/ทะเบียนข้อร้องเรียน.xlsx";
const DEFAULT_SHEET = "2026";

function cleanText(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text === "-") return null;
  return text;
}

async function main() {
  const excelPath = resolve(process.argv[2] || DEFAULT_EXCEL);
  const sheetWanted = String(process.argv[3] || DEFAULT_SHEET).trim();
  const workbook = XLSX.read(await readFile(excelPath), {
    type: "buffer",
    cellDates: true,
  });
  const sheetName = workbook.SheetNames.find(
    (name) => String(name).trim() === sheetWanted,
  );
  if (!sheetName) throw new Error(`ไม่พบ Sheet ${sheetWanted}`);

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    defval: null,
    raw: false,
  });
  const pairs = new Map();
  for (let index = 2; index < rows.length; index += 1) {
    const nameTh = cleanText(rows[index]?.[3]);
    const nameEn = cleanText(rows[index]?.[4]);
    if (nameTh && nameEn) pairs.set(nameTh, nameEn);
  }

  const pool = createPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Remove the previous incorrect alias-based backfill.
    await conn.query("UPDATE companies SET name_en = NULL");

    let updated = 0;
    for (const [nameTh, nameEn] of pairs) {
      const [result] = await conn.query(
        "UPDATE companies SET name_en = ? WHERE name = ?",
        [nameEn, nameTh],
      );
      updated += result.affectedRows;
    }

    await conn.commit();
    console.log(
      `Synced company English names from Complaint ${sheetName}: ${updated}/${pairs.size}`,
    );
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
