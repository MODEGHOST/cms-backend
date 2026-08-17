/**
 * Reject Tag PDF — A4 landscape, 2 tags/page.
 * Header matched to Excel: [แผ่นส่ง MACHINE] / [น้ำหนัก|value] + [คลังสินค้า rowspan].
 */
import PDFDocument from "pdfkit";
import {
  FONT_BOLD,
  FONT_REGULAR,
  text,
  formatQty,
  formatDateShort,
  normalizeMemoTagOverrides,
  qtyFromPalletLine,
  pdfBufferFromDoc,
  drawBox,
} from "./reject-pdf-shared.js";

const GRAY = "#A6A6A6";

function fmtWeight(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return text(value, "");
  return String(Number(n.toFixed(4)));
}

function planLine(record) {
  const date = formatDateShort(record.production_date).replace(/\//g, "-");
  const shift = text(record.shift, "");
  const machine = text(record.machine_name, "");
  return [date, shift ? `PLAN ${shift}` : "", machine].filter(Boolean).join(" ");
}

function centerText(doc, str, x, y, w, h, opts = {}) {
  const size = opts.size || 10;
  doc.font(opts.font || FONT_BOLD).fontSize(size).fillColor(opts.color || "#111");
  const textH = size + 2;
  const ty = y + Math.max(0, (h - textH) / 2);
  doc.text(text(str, ""), x + 2, ty, {
    width: w - 4,
    align: opts.align || "center",
    lineBreak: false,
  });
}

function drawOneTag(doc, record, overrides, palletIndex, box) {
  const { x, y, w, h } = box;
  const o = overrides;
  const line = o.pallet_lines[palletIndex] || "";
  const deliverQty = qtyFromPalletLine(line);
  const machine = text(record.machine_name, "");
  const customer = text(
    record.company_name,
    text(record.customer_alias_name, ""),
  );
  const flute = text(o.flute_name || record.flute_name, "");
  const cutQty = text(o.cut_qty || record.cut_qty, "");
  const itemCode = text(o.item_code || record.item_code, "");
  const bigQty = text(o.big_sheet_qty || record.big_sheet_qty, "");
  const bigSize = text(o.big_sheet_size || record.big_sheet_size, "");
  const smallQty = formatQty(
    o.customer_return_qty ?? record.claim_sheet_qty ?? o.small_sheet_qty,
  );
  const smallSize = text(o.small_sheet_size || record.small_sheet_size, "");
  const orderPart = formatQty(record.order_qty);
  const seqRight = text(record.shift, "");
  const weightPerSheet = Number(record.weight_per_sheet);
  const netWeight =
    deliverQty != null && Number.isFinite(weightPerSheet)
      ? Number((deliverQty * weightPerSheet).toFixed(4))
      : null;

  drawBox(doc, x, y, w, h, { lineWidth: 1.8 });

  // Header:
  // | แผ่นส่ง BHS              | คลังสินค้า |
  // | น้ำหนักต่อแผ่น | 0.13 กก. | (rowspan 2, horizontal text)
  const whW = Math.round(w * 0.3);
  const leftW = w - whW;
  const r1 = 30;
  const r2 = 28;
  const headH = r1 + r2;

  drawBox(doc, x, y, leftW, r1, { lineWidth: 1.1 });
  centerText(doc, `แผ่นส่ง ${machine}`.trim(), x, y, leftW, r1, { size: 14 });

  const labW = Math.round(leftW * 0.5);
  drawBox(doc, x, y + r1, labW, r2, { lineWidth: 1.1 });
  drawBox(doc, x + labW, y + r1, leftW - labW, r2, { lineWidth: 1.1 });
  centerText(doc, "น้ำหนักต่อแผ่น", x, y + r1, labW, r2, { size: 11 });
  const weightStr = fmtWeight(record.weight_per_sheet);
  centerText(
    doc,
    weightStr ? `${weightStr} กก.` : "",
    x + labW,
    y + r1,
    leftW - labW,
    r2,
    { size: 13 },
  );

  drawBox(doc, x + leftW, y, whW, headH, { lineWidth: 1.1 });
  centerText(doc, "คลังสินค้า", x + leftW, y, whW, headH, { size: 18 });

  let cy = y + headH;

  // ลอน | val | ผ่า | val | พาเลทที่ + เลขพาเลท
  const fluteH = 28;
  const widths = [
    Math.round(w * 0.14),
    Math.round(w * 0.12),
    Math.round(w * 0.14),
    Math.round(w * 0.12),
  ];
  widths.push(w - widths.reduce((a, b) => a + b, 0));
  let cx = x;
  const fluteCells = [
    { t: "ลอน", size: 11 },
    { t: flute, size: 13 },
    { t: "ผ่า", size: 11 },
    { t: cutQty, size: 13 },
    { t: "พาเลทที่", size: 11, value: String(palletIndex + 1) },
  ];
  fluteCells.forEach((cell, i) => {
    const cw = widths[i];
    drawBox(doc, cx, cy, cw, fluteH, { lineWidth: 1.1 });
    if (cell.value != null) {
      centerText(doc, cell.t, cx, cy, cw * 0.5, fluteH, { size: cell.size });
      centerText(doc, cell.value, cx + cw * 0.5, cy, cw * 0.5, fluteH, {
        size: 13,
      });
    } else {
      centerText(doc, cell.t, cx, cy, cw, fluteH, { size: cell.size });
    }
    cx += cw;
  });
  cy += fluteH;

  const addRow = (hh, fn) => {
    fn(cy, hh);
    cy += hh;
  };

  addRow(22, (yy, hh) => {
    const lw = Math.round(w * 0.22);
    drawBox(doc, x, yy, lw, hh, { lineWidth: 1.1 });
    drawBox(doc, x + lw, yy, w - lw, hh, { lineWidth: 1.1 });
    centerText(doc, "รหัสสินค้า", x, yy, lw, hh, { size: 10 });
    doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
    doc.text(itemCode, x + lw + 5, yy + 5, { width: w - lw - 10, lineBreak: false });
  });

  addRow(22, (yy, hh) => {
    const lw = Math.round(w * 0.22);
    drawBox(doc, x, yy, lw, hh, { lineWidth: 1.1 });
    drawBox(doc, x + lw, yy, w - lw, hh, { lineWidth: 1.1 });
    centerText(doc, "ชื่อสินค้า", x, yy, lw, hh, { size: 10 });
    doc.font(FONT_BOLD).fontSize(10).fillColor("#111");
    doc.text(text(record.size, ""), x + lw + 5, yy + 5, {
      width: w - lw - 10,
      lineBreak: false,
    });
  });

  addRow(22, (yy, hh) => {
    const a = Math.round(w * 0.18);
    const b = Math.round(w * 0.34);
    const c = Math.round(w * 0.2);
    const d = w - a - b - c;
    drawBox(doc, x, yy, a, hh, { lineWidth: 1.1 });
    drawBox(doc, x + a, yy, b, hh, { lineWidth: 1.1 });
    drawBox(doc, x + a + b, yy, c, hh, { lineWidth: 1.1 });
    drawBox(doc, x + a + b + c, yy, d, hh, { lineWidth: 1.1 });
    centerText(doc, "PDR. NO", x, yy, a, hh, { size: 9 });
    centerText(doc, text(record.pdr_no, ""), x + a, yy, b, hh, {
      size: 10,
      align: "left",
    });
    centerText(doc, "Sale Order", x + a + b, yy, c, hh, { size: 9 });
    centerText(doc, text(record.sale_order_no, ""), x + a + b + c, yy, d, hh, {
      size: 10,
      align: "left",
    });
  });

  const sheetParts = [0.38, 0.14, 0.1, 0.12].map((p) => Math.round(w * p));
  sheetParts.push(w - sheetParts.reduce((s, n) => s + n, 0));

  const drawSheetRow = (yy, hh, label, qty, sizeVal) => {
    const vals = [
      [label, 9],
      [qty, 12],
      ["แผ่น", 10],
      ["ขนาด", 10],
      [sizeVal, 12],
    ];
    let px = x;
    vals.forEach(([t, size], i) => {
      drawBox(doc, px, yy, sheetParts[i], hh, { lineWidth: 1.1 });
      centerText(doc, t, px, yy, sheetParts[i], hh, { size });
      px += sheetParts[i];
    });
  };

  addRow(24, (yy, hh) => {
    drawSheetRow(yy, hh, "จำนวนแผ่นใหญ่ที่ต้องการ", formatQty(bigQty), bigSize);
  });

  addRow(24, (yy, hh) => {
    drawSheetRow(yy, hh, "จำนวนแผ่นเล็กที่ต้องการ", smallQty, smallSize);
  });

  addRow(18, (yy, hh) => {
    drawBox(doc, x, yy, w * 0.55, hh, { lineWidth: 1.1 });
    drawBox(doc, x + w * 0.55, yy, w * 0.45, hh, { lineWidth: 1.1 });
    centerText(doc, "ลำดับที่ / วันที่ผลิต", x, yy, w * 0.55, hh, { size: 9 });
    centerText(doc, "จำนวนส่งมอบ ( แผ่น )", x + w * 0.55, yy, w * 0.45, hh, {
      size: 9,
    });
  });

  // Excel layout:
  // | 1680 - | 2 |          จำนวนส่งมอบ (tall empty / qty)          |
  // | 04-08-26 PLAN 2 BHS (left only) |                      |
  const seqLeftW = w * 0.55;
  const seqRightW = w * 0.45;
  const numH = 36;
  const planH = 20;
  const seqBlockH = numH + planH;

  // Right deliver cell spans both number + plan rows
  drawBox(doc, x + seqLeftW, cy, seqRightW, seqBlockH, { lineWidth: 1.1 });
  if (deliverQty != null) {
    centerText(doc, formatQty(deliverQty), x + seqLeftW, cy, seqRightW, seqBlockH, {
      size: 20,
    });
  }

  // Left number row: "1680 -" | shift/plan no
  const dashW = Math.round(seqLeftW * 0.72);
  const shiftW = seqLeftW - dashW;
  drawBox(doc, x, cy, dashW, numH, { lineWidth: 1.1 });
  drawBox(doc, x + dashW, cy, shiftW, numH, { lineWidth: 1.1 });
  const leftNum = orderPart ? `${orderPart} -` : "";
  centerText(doc, leftNum, x, cy, dashW, numH, { size: 20 });
  centerText(doc, seqRight || "", x + dashW, cy, shiftW, numH, { size: 20 });

  // Plan line — left column only (no yellow on print)
  drawBox(doc, x, cy + numH, seqLeftW, planH, { lineWidth: 1.1 });
  doc.font(FONT_BOLD).fontSize(10).fillColor("#111");
  doc.text(planLine(record), x + 5, cy + numH + 4, {
    width: seqLeftW - 10,
    lineBreak: false,
  });

  cy += seqBlockH;

  addRow(18, (yy, hh) => {
    drawBox(doc, x, yy, w * 0.62, hh, { lineWidth: 1.1 });
    drawBox(doc, x + w * 0.62, yy, w * 0.38, hh, { lineWidth: 1.1 });
    centerText(doc, "ชื่อลูกค้า", x, yy, w * 0.62, hh, { size: 9 });
    centerText(doc, "น้ำหนักสุทธิ  ( กก. )", x + w * 0.62, yy, w * 0.38, hh, {
      size: 9,
    });
  });

  addRow(30, (yy, hh) => {
    drawBox(doc, x, yy, w * 0.62, hh, { lineWidth: 1.1 });
    drawBox(doc, x + w * 0.62, yy, w * 0.38, hh, { lineWidth: 1.1 });
    centerText(doc, customer, x, yy, w * 0.62, hh, { size: 11, align: "left" });
    centerText(
      doc,
      netWeight != null ? fmtWeight(netWeight) : "",
      x + w * 0.62,
      yy,
      w * 0.38,
      hh,
      { size: 13 },
    );
  });

  // QC block (Excel):
  // | ผลการตรวจของ QC/QA   | ขาดจำนวน | เกินจำนวน |
  // | ไลน์เครื่อง BHS      |  (tall empty write area) |
  // left cell is one tall merged cell with 2 lines
  const qcLeftW = w * 0.5;
  const qcHalf = w * 0.25;
  const qcHeadH = 20;
  const qcBodyH = 42; // writing space under ขาดจำนวน / เกินจำนวน
  const qcH = qcHeadH + qcBodyH;

  drawBox(doc, x, cy, qcLeftW, qcH, { lineWidth: 1.1 });
  drawBox(doc, x + qcLeftW, cy, qcHalf, qcHeadH, { lineWidth: 1.1 });
  drawBox(doc, x + qcLeftW + qcHalf, cy, qcHalf, qcHeadH, { lineWidth: 1.1 });
  drawBox(doc, x + qcLeftW, cy + qcHeadH, qcHalf, qcBodyH, { lineWidth: 1.1 });
  drawBox(doc, x + qcLeftW + qcHalf, cy + qcHeadH, qcHalf, qcBodyH, {
    lineWidth: 1.1,
  });

  doc.font(FONT_BOLD).fontSize(10).fillColor("#111");
  doc.text("ผลการตรวจของ QC/QA", x + 6, cy + 10, {
    width: qcLeftW - 12,
    lineBreak: false,
  });
  doc.text(`ไลน์เครื่อง   ${machine}`, x + 6, cy + Math.round(qcH * 0.55), {
    width: qcLeftW - 12,
    lineBreak: false,
  });
  centerText(doc, "ขาดจำนวน", x + qcLeftW, cy, qcHalf, qcHeadH, { size: 9 });
  centerText(doc, "เกินจำนวน", x + qcLeftW + qcHalf, cy, qcHalf, qcHeadH, {
    size: 9,
  });
  cy += qcH;

  // วันที่ส่งของ | date | ส่งงาน Reject คืน
  addRow(24, (yy, hh) => {
    const d1 = w * 0.28;
    const d2 = w * 0.28;
    const d3 = w - d1 - d2;
    drawBox(doc, x, yy, d1, hh, { lineWidth: 1.1 });
    drawBox(doc, x + d1, yy, d2, hh, { lineWidth: 1.1 });
    drawBox(doc, x + d1 + d2, yy, d3, hh, { lineWidth: 1.1, fill: GRAY });
    centerText(doc, "วันที่ส่งของ", x, yy, d1, hh, { size: 10 });
    centerText(doc, formatDateShort(o.tag_ship_date), x + d1, yy, d2, hh, {
      size: 12,
    });
    centerText(doc, "ส่งงาน Reject คืน", x + d1 + d2, yy, d3, hh, { size: 12 });
  });

  const remain = y + h - cy;
  drawBox(doc, x, cy, w * 0.18, remain, { lineWidth: 1.1 });
  drawBox(doc, x + w * 0.18, cy, w * 0.82, remain, { lineWidth: 1.1 });
  centerText(doc, "หมายเหตุ", x, cy, w * 0.18, Math.min(22, remain), { size: 10 });
  doc.font(FONT_REGULAR).fontSize(9).fillColor("#111");
  doc.text(text(record.remark, ""), x + w * 0.18 + 4, cy + 5, {
    width: w * 0.82 - 8,
    height: remain - 8,
  });
}

export async function buildRejectTagPdf(record, overrides = {}) {
  const o = normalizeMemoTagOverrides(overrides, record);
  const count = o.pallet_count;
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 12, bottom: 12, left: 12, right: 12 },
    info: {
      Title: `Tag Reject ${text(record.pdr_no, record.id)}`,
      Author: "LEE FIBREBOARD",
      Subject: "แท๊ก Reject",
    },
  });

  doc.registerFont("Regular", FONT_REGULAR);
  doc.registerFont("Bold", FONT_BOLD);

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const margin = 10;
  const gap = 10;
  const tagW = (pageW - margin * 2 - gap) / 2;
  const tagH = pageH - margin * 2;

  for (let i = 0; i < count; i += 1) {
    if (i > 0 && i % 2 === 0) {
      doc.addPage({
        size: "A4",
        layout: "landscape",
        margins: { top: 12, bottom: 12, left: 12, right: 12 },
      });
    }
    const col = i % 2;
    drawOneTag(doc, record, o, i, {
      x: margin + col * (tagW + gap),
      y: margin,
      w: tagW,
      h: tagH,
    });
  }

  const buffer = await pdfBufferFromDoc(doc);
  const pdr = text(record.pdr_no, String(record.id || "tag"));
  return {
    buffer,
    contentType: "application/pdf",
    filename: `Tag-Reject-${pdr}.pdf`,
  };
}
