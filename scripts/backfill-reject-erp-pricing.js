/**
 * แก้ reject_records ที่มี pdr_no แล้ว — ดึง UOM จริงจาก ERP ต่อ PDR (ไม่เดา)
 *
 * Usage:
 *   node scripts/backfill-reject-erp-pricing.js --dry-run
 *   node scripts/backfill-reject-erp-pricing.js --apply
 *   node scripts/backfill-reject-erp-pricing.js --apply --id=5
 *
 * ต้องต่อ ERP ได้ (ERP_API_URL หรือ ERP_DEV_FIXTURE) และ CMS DB
 */
import "../src/core/load-env.js";
import { createPool } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { createErpPdrClient } from "../src/services/erp-pdr.js";
import { deriveSmallSheetPriceFromErp } from "../src/utils/derive-small-sheet-price.js";

const dryRun = !process.argv.includes("--apply");
const idArg = process.argv.find((a) => a.startsWith("--id="));
const onlyId = idArg ? Number(idArg.split("=")[1]) : null;

function toNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundCalc(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function syncQtyDerived(updates, current, qtyField, targetField, perUnit) {
  const qty = toNumber(current[qtyField]);
  if (qty == null || perUnit == null) return;
  const next = roundCalc(qty * perUnit);
  if (toNumber(current[targetField]) === next) return;
  updates[targetField] = next;
}

function buildUpdates(current, erpRow, { hasOrderNo }) {
  const updates = {};
  const price = deriveSmallSheetPriceFromErp(erpRow);
  const weight = toNumber(erpRow.weight_per_sheet);

  if (price != null && toNumber(current.price_per_sheet) !== price) {
    updates.price_per_sheet = price;
  }
  if (weight != null && toNumber(current.weight_per_sheet) !== weight) {
    updates.weight_per_sheet = weight;
  }

  if (hasOrderNo) {
    const seq =
      erpRow.order_no != null && String(erpRow.order_no).trim() !== ""
        ? String(erpRow.order_no).trim()
        : null;
    if (seq && !current.order_no) updates.order_no = seq;
  }

  const demandQty = toNumber(erpRow.demand_qty);
  if (demandQty != null && current.order_qty == null) {
    updates.order_qty = demandQty;
  }

  const priceUsed = updates.price_per_sheet ?? toNumber(current.price_per_sheet);
  const weightUsed = updates.weight_per_sheet ?? toNumber(current.weight_per_sheet);

  const claimQty = toNumber(current.claim_sheet_qty);
  if (claimQty != null) {
    if (priceUsed != null) {
      const amount = roundCalc(claimQty * priceUsed);
      if (toNumber(current.claim_amount) !== amount) {
        updates.claim_amount = amount;
      }
    }
    if (weightUsed != null) {
      const kg = roundCalc(claimQty * weightUsed);
      if (toNumber(current.claim_weight_kg) !== kg) {
        updates.claim_weight_kg = kg;
      }
    }
  }

  syncQtyDerived(updates, current, "destroy_bl_qty", "destroy_bl_amount", priceUsed);
  syncQtyDerived(updates, current, "destroy_bl_qty", "destroy_bl_weight", weightUsed);
  syncQtyDerived(updates, current, "return_to_customer_qty", "return_amount", priceUsed);
  syncQtyDerived(updates, current, "return_to_customer_qty", "return_kg", weightUsed);

  return { updates, price, weight };
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [config.db.database, table, column],
  );
  return rows.length > 0;
}

async function main() {
  const pool = createPool();
  const erp = createErpPdrClient({ config });
  const conn = await pool.getConnection();

  try {
    const hasOrderNo = await columnExists(conn, "reject_records", "order_no");
    if (!hasOrderNo) {
      console.warn(
        "WARN: reject_records.order_no ยังไม่มี — รัน scripts/ensure-reject-order-no.js ก่อน",
      );
    }

    const params = [];
    let where = "WHERE TRIM(COALESCE(pdr_no, '')) <> ''";
    if (onlyId) {
      where += " AND id = ?";
      params.push(onlyId);
    }

    const [rows] = await conn.query(
      `SELECT * FROM reject_records ${where} ORDER BY id`,
      params,
    );

    if (!rows.length) {
      console.log("ไม่พบ reject_records ที่มี pdr_no");
      return;
    }

    console.log(
      `${dryRun ? "[DRY-RUN]" : "[APPLY]"} แก้ ${rows.length} รายการ (เฉพาะ PDR ใน reject_records)`,
    );

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      const pdr = String(row.pdr_no || "").trim();
      const erpResult = await erp.getByPdrNo(pdr);

      if (!erpResult.ok || !erpResult.data?.[0]) {
        console.log(`SKIP id=${row.id} ${pdr}: ERP — ${erpResult.error || "ไม่พบข้อมูล"}`);
        skipped += 1;
        continue;
      }

      const erpRow = erpResult.data[0];
      const { updates, price, weight } = buildUpdates(row, erpRow, { hasOrderNo });

      if (!Object.keys(updates).length) {
        console.log(`OK   id=${row.id} ${pdr}: ไม่ต้องแก้`);
        continue;
      }

      const beforePrice = toNumber(row.price_per_sheet);
      const beforeAmount = toNumber(row.claim_amount);

      console.log(
        `FIX  id=${row.id} ${pdr} | UOM=${erpRow.unit_of_measure || "-"} sales=${erpRow.sales_unit_price ?? "-"} uom_qty=${erpRow.uom_qty_per ?? "-"} | price ${beforePrice} → ${updates.price_per_sheet ?? beforePrice} | claim_amount ${beforeAmount} → ${updates.claim_amount ?? beforeAmount}`,
      );

      if (!dryRun) {
        const keys = Object.keys(updates);
        const sets = keys.map((k) => `${k} = ?`).join(", ");
        const values = keys.map((k) => updates[k]);
        values.push(row.id);
        await conn.query(`UPDATE reject_records SET ${sets} WHERE id = ?`, values);
      }
      updated += 1;
    }

    console.log(
      `\nสรุป: แก้ ${updated} | ข้าม ${skipped} | ล้มเหลว ${failed} | รวม ${rows.length}`,
    );
    if (dryRun) {
      console.log("รันใหม่ด้วย --apply เพื่อบันทึกจริง");
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
