/**
 * Shared helpers for Reject Memo / Tag PDF generation.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFluteFromSize } from "../utils/parse-flute-from-size.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PDF_ASSETS = resolve(__dirname, "../../assets");
export const FONT_REGULAR = resolve(PDF_ASSETS, "fonts/tahoma.ttf");
export const FONT_BOLD = resolve(PDF_ASSETS, "fonts/tahomabd.ttf");

export const YELLOW = "#FFE600";
export const LINE = "#222222";

export function text(value, fallback = "") {
  const raw = value == null ? "" : String(value).trim();
  return raw || fallback;
}

export function formatQty(value) {
  if (value == null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return text(value, "");
  return number.toLocaleString("en-US");
}

export function formatDateShort(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value.trim())) {
    return value.trim();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return text(value, "");
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`;
}

export function formatDateFull(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(value.trim())) {
    return value.trim();
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return text(value, "");
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

export function parsePalletLines(raw) {
  if (Array.isArray(raw)) {
    return raw.map((line) => String(line || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((line) => String(line || "").trim()).filter(Boolean);
      }
    } catch {
      // fall through — treat as newline / comma separated
    }
    return trimmed
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

/** Extract leading qty from "800*1" → 800 */
export function qtyFromPalletLine(line) {
  const match = String(line || "").match(/^\s*([\d,.]+)/);
  if (!match) return null;
  const n = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function normalizeMemoTagOverrides(input = {}, record = {}) {
  const palletLines = parsePalletLines(
    input.pallet_lines ?? record.pallet_lines,
  );
  const palletCountRaw =
    input.pallet_count ??
    record.pallet_count ??
    (palletLines.length > 0 ? palletLines.length : 1);
  const palletCount = Math.max(1, Math.min(50, Number(palletCountRaw) || 1));

  while (palletLines.length < palletCount) {
    palletLines.push("");
  }

  const customerReturnRaw =
    input.customer_return_qty ??
    input.memo_customer_return_qty ??
    record.memo_customer_return_qty ??
    record.claim_sheet_qty ??
    null;
  const customerReturnQty =
    customerReturnRaw == null || customerReturnRaw === ""
      ? null
      : Number(customerReturnRaw);

  // จำนวนที่แจ้งส่ง — จากค่าที่กรอกใน Memo เท่านั้น (ไม่ดึงจากฟอร์ม)
  const notifiedRaw = input.notified_ship_qty ?? input.memo_notified_ship_qty ?? null;
  const notifiedShipQty =
    notifiedRaw == null || notifiedRaw === "" ? null : Number(notifiedRaw);

  // ส่งพร้อมงานซ่อม = ลูกค้าคืนงาน − จำนวนที่แจ้งส่ง
  const repairWithQty =
    Number.isFinite(customerReturnQty) && Number.isFinite(notifiedShipQty)
      ? Number((customerReturnQty - notifiedShipQty).toFixed(4))
      : input.repair_with_qty ?? record.repair_with_qty ?? null;

  return {
    lot_no: text(
      input.lot_no ?? input.memo_lot_no ?? record.memo_lot_no ?? record.pdr_no,
      "",
    ),
    pallet_count: palletCount,
    pallet_lines: palletLines.slice(0, palletCount),
    notified_ship_qty: Number.isFinite(notifiedShipQty) ? notifiedShipQty : null,
    repair_with_qty: repairWithQty,
    customer_return_qty: Number.isFinite(customerReturnQty)
      ? customerReturnQty
      : null,
    tag_ship_date:
      input.tag_ship_date ??
      record.tag_ship_date ??
      record.customer_ship_date ??
      null,
    // Optional Tag layout fields (download-only overrides)
    item_code: text(input.item_code ?? record.item_code, ""),
    flute_name: text(
      input.flute_name ??
        record.flute_name ??
        parseFluteFromSize(record.size),
      "",
    ),
    cut_qty: text(input.cut_qty ?? record.cut_qty, ""),
    big_sheet_qty: text(input.big_sheet_qty ?? record.big_sheet_qty, ""),
    big_sheet_size: text(input.big_sheet_size ?? record.big_sheet_size, ""),
    small_sheet_size: text(input.small_sheet_size ?? record.small_sheet_size, ""),
  };
}

export function pdfBufferFromDoc(doc) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

export function drawBox(doc, x, y, w, h, options = {}) {
  doc.save();
  if (options.fill) {
    doc.rect(x, y, w, h).fill(options.fill);
  }
  doc.lineWidth(options.lineWidth ?? 0.8);
  doc.strokeColor(options.stroke || LINE);
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

export function underlineField(doc, x, y, w) {
  doc
    .save()
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineWidth(0.6)
    .strokeColor(LINE)
    .stroke()
    .restore();
}
