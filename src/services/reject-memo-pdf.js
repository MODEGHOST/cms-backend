/**
 * Reject Memo PDF — A4 portrait, matched to Excel sheet MEMO.
 * Underlines stay inside the page frame. Yellow only on key filled values.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import PDFDocument from "pdfkit";
import {
  FONT_BOLD,
  FONT_REGULAR,
  PDF_ASSETS,
  YELLOW,
  LINE,
  text,
  formatQty,
  formatDateFull,
  normalizeMemoTagOverrides,
  pdfBufferFromDoc,
} from "./reject-pdf-shared.js";
import { formatProblemLabel } from "../utils/problem-names.js";

const SIGNATURE_PATH = resolve(PDF_ASSETS, "images/reject-memo-signature.png");

function loadSignature() {
  if (!existsSync(SIGNATURE_PATH)) return null;
  return readFileSync(SIGNATURE_PATH);
}

function hLine(doc, x, y, w, width = 1) {
  if (w <= 0) return;
  doc
    .save()
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineWidth(width)
    .strokeColor(LINE)
    .stroke()
    .restore();
}

function underline(doc, x, y, w, maxX) {
  const width = maxX != null ? Math.min(w, maxX - x) : w;
  hLine(doc, x, y, Math.max(0, width), 0.7);
}

function dottedLines(doc, x, y, w, count, gap = 16) {
  for (let i = 0; i < count; i += 1) {
    const yy = y + i * gap;
    doc
      .save()
      .moveTo(x, yy)
      .lineTo(x + w, yy)
      .lineWidth(0.6)
      .dash(1.2, { space: 2 })
      .strokeColor("#444")
      .stroke()
      .undash()
      .restore();
  }
}

function valueText(doc, value, x, y, w, opts = {}) {
  doc
    .font(opts.font || FONT_REGULAR)
    .fontSize(opts.size || 11)
    .fillColor(opts.color || "#111")
    .text(text(value, ""), x + (opts.padX || 0), y, {
      width: Math.max(0, w - (opts.padX || 0) * 2),
      align: opts.align || "left",
      lineBreak: false,
    });
}

function yellowValue(doc, value, x, y, w, opts = {}) {
  const h = opts.h || 15;
  doc.save();
  doc.rect(x, y - 1, w, h).fill(YELLOW);
  doc.restore();
  valueText(doc, value, x, y, w, opts);
}

export async function buildRejectMemoPdf(record, overrides = {}) {
  const o = normalizeMemoTagOverrides(overrides, record);
  const doc = new PDFDocument({
    size: "A4",
    layout: "portrait",
    margins: { top: 36, bottom: 36, left: 42, right: 42 },
    info: {
      Title: `Memo Reject ${text(record.pdr_no, record.id)}`,
      Author: "LEE FIBREBOARD",
      Subject: "ส่งคืนงานREJECT",
    },
  });

  doc.registerFont("Regular", FONT_REGULAR);
  doc.registerFont("Bold", FONT_BOLD);

  const left = 48;
  const top = 42;
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const right = pageW - 48;
  const bottom = pageH - 42;
  const boxW = right - left;
  const contentLeft = left + 14;
  const contentW = boxW - 28;
  const contentRight = contentLeft + contentW;

  // Outer border
  doc
    .save()
    .lineWidth(1.4)
    .strokeColor(LINE)
    .rect(left, top, boxW, bottom - top)
    .stroke()
    .restore();

  let y = top + 16;

  // Title centered + underline
  doc.font(FONT_BOLD).fontSize(15).fillColor("#111");
  doc.text("LEE FIBREBOARD.LTD. MEMO RANDUM", contentLeft, y, {
    width: contentW,
    align: "center",
  });
  y += 20;
  hLine(doc, contentLeft, y, contentW, 1.1);
  y += 16;

  const labelW = 92;
  const row = 20;

  const writeRow = (label, value, opts = {}) => {
    doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
    doc.text(label, contentLeft, y, { width: labelW, lineBreak: false });
    const vx = contentLeft + labelW;
    const vw = Math.min(
      opts.valueW || contentRight - vx,
      contentRight - vx,
    );
    valueText(doc, value, vx, y, vw, {
      color: opts.red ? "#CC0000" : "#111",
      size: 11,
      align: opts.align || "left",
    });
    if (opts.underline !== false) {
      const uw = Math.min(opts.underlineW || vw, contentRight - vx);
      underline(doc, vx, y + 14, uw, contentRight);
    }
    y += opts.gap || row;
  };

  // ATTN + DATE same line
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("ATTN :", contentLeft, y, { lineBreak: false });
  doc.font(FONT_REGULAR).text("วางแผน/การตลาด", contentLeft + labelW, y, {
    lineBreak: false,
  });
  underline(doc, contentLeft + labelW, y + 14, 160, contentRight);
  const dateLabelX = Math.min(contentLeft + 320, contentRight - 140);
  doc.font(FONT_BOLD).text("DATE:", dateLabelX, y, { lineBreak: false });
  doc.font(FONT_REGULAR).text(formatDateFull(new Date()), dateLabelX + 40, y, {
    lineBreak: false,
  });
  underline(doc, dateLabelX + 40, y + 14, 90, contentRight);
  y += row;

  writeRow("SUBJECT:", "ส่งคืนงานREJECT", { underlineW: 200 });
  writeRow(
    "ลูกค้า:",
    text(record.company_name, text(record.customer_alias_name, "")),
  );
  writeRow("ORDER:", formatQty(record.order_qty), { underlineW: 120 });
  writeRow("เลขที่IV:", text(record.invoice_no, ""), { underlineW: 160 });
  writeRow("LOT NO:", o.lot_no, { underlineW: 170 });
  writeRow("SOSA:", text(record.sale_order_no, ""), { underlineW: 160 });
  writeRow("SIZE:", text(record.size, ""));

  // ผลิต / เครื่อง
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("ผลิต:", contentLeft, y, { lineBreak: false });
  doc
    .font(FONT_REGULAR)
    .text(formatDateFull(record.production_date), contentLeft + labelW, y, {
      lineBreak: false,
    });
  underline(doc, contentLeft + labelW, y + 14, 100, contentRight);
  const machineLabelX = Math.min(contentLeft + 230, contentRight - 200);
  doc.font(FONT_BOLD).text("เครื่อง", machineLabelX, y, { lineBreak: false });
  doc
    .font(FONT_REGULAR)
    .text(text(record.machine_name, ""), machineLabelX + 50, y, {
      width: contentRight - (machineLabelX + 50),
      lineBreak: false,
    });
  underline(doc, machineLabelX + 50, y + 14, 120, contentRight);
  y += row;

  // จำนวนที่แจ้งส่ง
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("จำนวนที่แจ้งส่ง", contentLeft, y, { lineBreak: false });
  valueText(doc, formatQty(o.notified_ship_qty), contentLeft + 120, y, 70, {
    align: "center",
  });
  underline(doc, contentLeft + 120, y + 14, 70, contentRight);
  doc.font(FONT_REGULAR).text("แผ่น", contentLeft + 198, y, { lineBreak: false });
  y += row + 2;

  // จำนวนพาเลท + breakdown
  const palletY = y;
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("จำนวนพาเลท", contentLeft, y, { lineBreak: false });
  valueText(doc, String(o.pallet_count), contentLeft + 120, y, 36, {
    align: "center",
  });
  underline(doc, contentLeft + 120, y + 14, 36, contentRight);
  doc.font(FONT_REGULAR).text("พาเลท", contentLeft + 162, y, { lineBreak: false });

  const detailX = contentLeft + 230;
  const detailW = Math.min(88, contentRight - detailX - 36);
  o.pallet_lines.forEach((line, idx) => {
    const dy = palletY + idx * 18;
    valueText(doc, line, detailX, dy, detailW, { align: "center" });
    underline(doc, detailX, dy + 14, detailW, contentRight);
    doc.font(FONT_REGULAR).fontSize(11).fillColor("#111");
    doc.text("แผ่น", detailX + detailW + 6, dy, { lineBreak: false });
  });
  y = palletY + Math.max(row, o.pallet_lines.length * 18) + 6;

  // Signature
  const signature = loadSignature();
  const sigH = 78;
  if (signature) {
    doc.image(signature, contentLeft + 4, y, {
      fit: [150, sigH],
      align: "left",
      valign: "center",
    });
  }
  y += sigH + 8;

  // Divider before repair block
  hLine(doc, contentLeft, y, contentW, 1);
  y += 14;

  // ส่งพร้อมงานซ่อม
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("ส่งพร้อมงานซ่อมจำนวน", contentLeft, y, { lineBreak: false });
  valueText(doc, formatQty(o.repair_with_qty), contentLeft + 155, y, 64, {
    color: "#CC0000",
    align: "center",
  });
  underline(doc, contentLeft + 155, y + 14, 64, contentRight);
  doc.font(FONT_REGULAR).fillColor("#111").text("แผ่น", contentLeft + 226, y, {
    lineBreak: false,
  });
  y += row + 2;

  // ลูกค้าคืนงาน + ปัญหา (underline ต้องไม่ล้นกรอบขวา)
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("ลูกค้าคืนงานจำนวน", contentLeft, y, { lineBreak: false });
  yellowValue(doc, formatQty(o.customer_return_qty), contentLeft + 155, y, 64, {
    align: "center",
  });
  underline(doc, contentLeft + 155, y + 14, 64, contentRight);
  doc.font(FONT_REGULAR).text("แผ่น", contentLeft + 226, y, { lineBreak: false });

  const problemLabelX = contentLeft + 270;
  const problemValueX = contentLeft + 315;
  const problemValueW = Math.max(40, contentRight - problemValueX);
  doc.font(FONT_BOLD).text("ปัญหา", problemLabelX, y, { lineBreak: false });
  valueText(doc, text(formatProblemLabel(record), ""), problemValueX, y, problemValueW);
  underline(doc, problemValueX, y + 14, problemValueW, contentRight);
  y += row + 10;

  // REMARKS + dotted lines
  doc.font(FONT_BOLD).fontSize(11).fillColor("#111");
  doc.text("REMARKS:", contentLeft, y, { lineBreak: false });
  y += 18;
  dottedLines(doc, contentLeft, y, contentW, 4, 18);
  if (text(record.remark, "")) {
    doc.font(FONT_REGULAR).fontSize(10).fillColor("#111");
    doc.text(text(record.remark, ""), contentLeft, y - 12, {
      width: contentW,
      height: 70,
    });
  }

  const buffer = await pdfBufferFromDoc(doc);
  const pdr = text(record.pdr_no, String(record.id || "memo"));
  return {
    buffer,
    contentType: "application/pdf",
    filename: `Memo-Reject-${pdr}.pdf`,
  };
}
