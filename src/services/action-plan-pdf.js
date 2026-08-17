import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { normalizePlanForm, groupImagesByPdfSlot } from "./plan-form.js";
import { formatProblemLabel, formatProblemNameEn } from "../utils/problem-names.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "../../assets");
const FONT_REGULAR = resolve(ASSETS, "fonts/tahoma.ttf");
const FONT_BOLD = resolve(ASSETS, "fonts/tahomabd.ttf");
const LOGO_PATH = resolve(ASSETS, "images/lee-fibreboard-logo.png");
const LOGO_EXCEL_PATH = resolve(ASSETS, "images/lee-logo-from-excel.png");

const YELLOW = "#FFE600";
const RED = "#CC0000";
const GRAY_HEADER = "#D9D9D9";
const LINE = "#222222";

/** PDFKit supports JPEG/PNG only — convert other formats via sharp. */
const PDF_NATIVE_IMAGE_RE = /\.(jpe?g|png)$/i;
const PDF_NATIVE_MIME = new Set(["image/jpeg", "image/jpg", "image/png"]);

async function toPdfSafeImageBuffer(filePath, mimeType = "") {
  const raw = await readFile(filePath);
  const mime = String(mimeType || "").toLowerCase();
  const ext = extname(filePath).toLowerCase();
  if (PDF_NATIVE_MIME.has(mime) || PDF_NATIVE_IMAGE_RE.test(ext)) {
    // Downscale huge photos so PDFKit stays responsive under concurrent downloads.
    if (raw.length > 1_500_000) {
      try {
        return await sharp(raw)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
      } catch {
        return raw;
      }
    }
    return raw;
  }
  try {
    return await sharp(raw)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

function text(value, fallback = "-") {
  const raw = value == null ? "" : String(value).trim();
  return raw || fallback;
}

function formatDateShort(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = String(date.getFullYear()).slice(-2);
  return `${d}/${m}/${y}`;
}

function formatDateFull(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${date.getFullYear()}`;
}

function formatQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return text(value, "");
  return number.toLocaleString("en-US");
}

/**
 * Draw value on a single line — shrink font until it fits (no wrap).
 * Never pass `width` to doc.text (PDFKit may still wrap); clip + truncate instead.
 */
function drawSingleLine(
  doc,
  value,
  x,
  y,
  width,
  { font = "Regular", size = 9, minSize = 5, color = "#111" } = {},
) {
  const raw = value == null ? "" : String(value);
  if (!raw || width <= 0) return;

  let fontSize = size;
  doc.font(font).fillColor(color);
  while (fontSize > minSize) {
    doc.fontSize(fontSize);
    if (doc.widthOfString(raw) <= width) break;
    fontSize -= 0.25;
  }
  doc.fontSize(fontSize);

  let display = raw;
  if (doc.widthOfString(display) > width) {
    const ellipsis = "…";
    while (display.length > 0 && doc.widthOfString(display + ellipsis) > width) {
      display = display.slice(0, -1);
    }
    display = display ? display + ellipsis : "";
  }
  if (!display) return;

  doc.save();
  doc.rect(x - 0.5, y - 1, width + 1, fontSize + 5).clip();
  doc.text(display, x, y, { lineBreak: false });
  doc.restore();
}

/** Problem Thai + EN on one line, sharing remaining cell width. */
function drawProblemSingleLine(doc, thaiName, enName, x, y, width) {
  const th = thaiName && thaiName !== "-" ? String(thaiName) : "";
  const en = enName ? String(enName).trim() : "";
  if ((!th && !en) || width <= 0) return;

  const gap = th && en ? 4 : 0;
  let fontSize = 9;
  const minSize = 5;

  const totalWidth = (fs) => {
    doc.font("Regular").fontSize(fs);
    return (
      (th ? doc.widthOfString(th) : 0) + gap + (en ? doc.widthOfString(en) : 0)
    );
  };

  while (fontSize > minSize && totalWidth(fontSize) > width) {
    fontSize -= 0.25;
  }
  doc.font("Regular").fontSize(fontSize);

  let thDisplay = th;
  let enDisplay = en;
  let cursor = x;
  const endX = x + width;

  if (thDisplay) {
    const maxTh = enDisplay ? Math.max(24, width * 0.55) : width;
    if (doc.widthOfString(thDisplay) > maxTh) {
      const ellipsis = "…";
      while (
        thDisplay.length > 0 &&
        doc.widthOfString(thDisplay + ellipsis) > maxTh
      ) {
        thDisplay = thDisplay.slice(0, -1);
      }
      thDisplay = thDisplay ? thDisplay + ellipsis : "";
    }
    doc.fillColor("#111");
    doc.save();
    doc.rect(cursor - 0.5, y - 1, endX - cursor + 0.5, fontSize + 5).clip();
    doc.text(thDisplay, cursor, y, { lineBreak: false });
    doc.restore();
    cursor += doc.widthOfString(thDisplay) + gap;
  }

  if (enDisplay && cursor < endX) {
    const remain = endX - cursor;
    doc.font("Regular").fontSize(fontSize);
    if (doc.widthOfString(enDisplay) > remain) {
      const ellipsis = "…";
      while (
        enDisplay.length > 0 &&
        doc.widthOfString(enDisplay + ellipsis) > remain
      ) {
        enDisplay = enDisplay.slice(0, -1);
      }
      enDisplay = enDisplay ? enDisplay + ellipsis : "";
    }
    if (enDisplay) {
      doc.fillColor(RED);
      doc.save();
      doc.rect(cursor - 0.5, y - 1, remain + 0.5, fontSize + 5).clip();
      doc.text(enDisplay, cursor, y, { lineBreak: false });
      doc.restore();
      doc.fillColor("#111");
    }
  }
}

function ngPercent(ngQty, demandQty) {
  const ng = Number(ngQty);
  const demand = Number(demandQty);
  if (!Number.isFinite(ng) || !Number.isFinite(demand) || demand <= 0) return "";
  return `${((ng / demand) * 100).toFixed(2)}%`;
}

function isExternal(scope) {
  return String(scope || "").trim() === "ภายนอก";
}

function isInternal(scope) {
  return !isExternal(scope);
}

function drawBox(doc, x, y, w, h, options = {}) {
  doc.save();
  if (options.fill) {
    doc.rect(x, y, w, h).fill(options.fill);
  }
  doc.lineWidth(options.lineWidth ?? 0.8);
  doc.strokeColor(options.stroke || LINE);
  doc.rect(x, y, w, h).stroke();
  doc.restore();
}

function underline(doc, x, y, w) {
  doc
    .save()
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineWidth(0.6)
    .strokeColor(LINE)
    .stroke()
    .restore();
}

function dottedLine(doc, x, y, w) {
  doc
    .save()
    .moveTo(x, y)
    .lineTo(x + w, y)
    .lineWidth(0.6)
    .dash(1.2, { space: 1.8 })
    .strokeColor("#555")
    .stroke()
    .undash()
    .restore();
}

/** Checkbox แบบ Excel — ติ๊กแล้วพื้นเหลือง */
function checkbox(doc, x, y, checked, size = 10) {
  doc.save();
  if (checked) {
    doc.rect(x, y, size, size).fill(YELLOW);
  }
  doc.lineWidth(0.8).strokeColor(LINE).rect(x, y, size, size).stroke();
  if (checked) {
    doc
      .moveTo(x + 1.8, y + 5)
      .lineTo(x + 4, y + 7.5)
      .lineTo(x + 8.2, y + 2)
      .lineWidth(1.2)
      .stroke("#111");
  }
  doc.restore();
}

/**
 * วาดรูปลายเซ็นแบบ object-contain (เหมือน Preview)
 * — คงสัดส่วน อยู่ภายในช่อง ไม่ซูมแบบ cover ที่ทำให้ลายเซ็นถูกตัด/บิด
 */
function drawSignature(doc, buffer, x, y, boxW, boxH, { pad = 2 } = {}) {
  if (!buffer || boxW <= pad * 2 || boxH <= pad * 2) return;
  try {
    const maxW = boxW - pad * 2;
    const maxH = boxH - pad * 2;
    doc.save();
    doc.rect(x + pad, y + pad, maxW, maxH).clip();
    doc.image(buffer, x + pad, y + pad, {
      fit: [maxW, maxH],
      align: "center",
      valign: "center",
    });
    doc.restore();
  } catch {
    /* ignore */
  }
}

function buildFilename(record) {
  const raw = record.confirmed_at || record.completed_date || new Date();
  const d = raw instanceof Date ? raw : new Date(raw);
  const stamp = Number.isNaN(d.getTime())
    ? "00000000"
    : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const parts = [
    stamp,
    text(record.document_no, "AP"),
    text(record.problem_name, "problem").replace(/[\\/:*?"<>|]/g, " "),
    text(record.responsible_department_name, "dept").replace(/[\\/:*?"<>|]/g, " "),
    text(record.machine_name, "").replace(/[\\/:*?"<>|]/g, " "),
  ].filter(Boolean);
  return `${parts.join("_")}.pdf`;
}

/**
 * Build Corrective Action Plan PDF — layout matched to Excel-exported CAP PDF.
 * Page size: Letter (เหมือนไฟล์ที่บันทึกจาก Excel) · 1 หน้า
 */
export async function buildActionPlanPdf(record, { attachments = [], uploadsDirectory } = {}) {
  if (String(record?.document_accepted || "").toUpperCase() !== "P") {
    const error = new Error("สร้างเอกสาร Action Plan ได้เฉพาะกรณีที่เลือกรับเอกสาร (P)");
    error.status = 400;
    throw error;
  }
  if (String(record?.workflow_status || "") !== "completed") {
    const error = new Error("สร้างเอกสาร Action Plan ได้หลัง QA Confirm และปิดงานแล้วเท่านั้น");
    error.status = 400;
    throw error;
  }

  if (!existsSync(FONT_REGULAR) || !existsSync(FONT_BOLD)) {
    const error = new Error("ไม่พบฟอนต์สำหรับสร้าง PDF");
    error.status = 500;
    throw error;
  }

  const plan = normalizePlanForm(record.plan_form_json);
  const planSigIds = new Set();
  for (const row of plan.contributors) {
    if (row.signatureId) planSigIds.add(Number(row.signatureId));
  }
  for (const role of Object.values(plan.approvals || {})) {
    if (role?.signatureId) planSigIds.add(Number(role.signatureId));
  }

  const imageAttachments = (attachments || []).filter(
    (item) =>
      String(item.kind || "file") !== "signature" &&
      !planSigIds.has(Number(item.id)) &&
      String(item.mime_type || "").startsWith("image/"),
  );
  const imagesBySlot = groupImagesByPdfSlot(imageAttachments, plan);

  const attachmentById = new Map(
    (attachments || []).map((item) => [Number(item.id), item]),
  );

  // Preload + convert WebP/AVIF → PNG so PDFKit can embed them (limited concurrency)
  const imageBufferById = new Map();
  const loadJobs = (attachments || [])
    .filter((attachment) => attachment?.stored_name && uploadsDirectory)
    .map((attachment) => async () => {
      const filePath = resolve(uploadsDirectory, attachment.stored_name);
      if (!existsSync(filePath)) return;
      try {
        const buffer = await toPdfSafeImageBuffer(filePath, attachment.mime_type);
        if (buffer) imageBufferById.set(Number(attachment.id), buffer);
      } catch {
        /* skip unreadable */
      }
    });
  const loadBatch = 3;
  for (let i = 0; i < loadJobs.length; i += loadBatch) {
    await Promise.all(loadJobs.slice(i, i + loadBatch).map((job) => job()));
  }

  const loadImage = (attachment) => {
    if (!attachment) return null;
    return imageBufferById.get(Number(attachment.id)) || null;
  };

  // Letter portrait — ตรงกับ PDF ที่ Export จาก Excel (612 x 792)
  const pageW = 612;
  const pageH = 792;
  const margin = 18;
  const contentW = pageW - margin * 2;
  const pageBottom = pageH - margin - 12;

  const doc = new PDFDocument({
    size: [pageW, pageH],
    layout: "portrait",
    autoFirstPage: true,
    bufferPages: true,
    margins: { top: margin, bottom: margin, left: margin, right: margin },
    info: {
      Title: `Corrective Action Plan ${text(record.document_no, "")}`,
      Author: "LEE FIBREBOARD",
      Subject: "แผนการปฏิบัติการ",
    },
  });

  doc.registerFont("Regular", FONT_REGULAR);
  doc.registerFont("Bold", FONT_BOLD);

  const chunks = [];
  const done = new Promise((resolvePromise, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolvePromise(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  let y = margin;
  const left = margin;

  // ══════════ Header: logo | title | meta (3 ช่องเหมือน Excel) ══════════
  const headerH = 48;
  const logoW = 150;
  const metaW = 150;
  const titleW = contentW - logoW - metaW;

  drawBox(doc, left, y, logoW, headerH);
  drawBox(doc, left + logoW, y, titleW, headerH, { fill: GRAY_HEADER });
  drawBox(doc, left + logoW + titleW, y, metaW, headerH, { fill: GRAY_HEADER });
  // เส้นแบ่ง meta เป็น 2 แถว
  doc
    .moveTo(left + logoW + titleW, y + headerH / 2)
    .lineTo(left + contentW, y + headerH / 2)
    .lineWidth(0.7)
    .stroke(LINE);

  // โลโก้จาก Excel เป็นแบนเนอร์แนวนอน (มีชื่อบริษัทในรูปแล้ว) — อย่าวาดข้อความทับ
  // ถ้าไม่มี ใช้ไอคอน + ข้อความแยก (แบบ Preview)
  if (existsSync(LOGO_EXCEL_PATH)) {
    try {
      doc.image(LOGO_EXCEL_PATH, left + 4, y + 6, {
        fit: [logoW - 8, headerH - 12],
        align: "left",
        valign: "center",
      });
    } catch {
      /* ignore */
    }
  } else if (existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, left + 6, y + 8, { fit: [32, 32] });
    } catch {
      /* ignore */
    }
    doc.font("Bold").fontSize(9).fillColor("#111");
    doc.text("LEE FIBREBOARD", left + 42, y + 12, { width: logoW - 48, lineBreak: false });
    doc.font("Regular").fontSize(7).fillColor("#333");
    doc.text("บริษัท ลีไฟเบอร์บอร์ด จำกัด", left + 42, y + 26, {
      width: logoW - 48,
      lineBreak: false,
    });
  }

  doc.font("Bold").fontSize(13).fillColor("#111");
  doc.text("แผนการปฏิบัติการ", left + logoW, y + 8, {
    width: titleW,
    align: "center",
  });
  doc.font("Bold").fontSize(10);
  doc.text("CORRECTIVE ACTION PLAN", left + logoW, y + 26, {
    width: titleW,
    align: "center",
  });

  const metaX = left + logoW + titleW;
  doc.font("Regular").fontSize(8).fillColor("#111");
  doc.text(
    `วันที่จัดทำ :  ${formatDateShort(record.confirmed_at || record.completed_date || new Date())}`,
    metaX + 6,
    y + 8,
    { width: metaW - 12 },
  );
  doc.text(`เลขที่ :  ${text(record.document_no, "")}`, metaX + 6, y + 30, {
    width: metaW - 12,
  });
  y += headerH;

  // ══════════ หน่วยงานที่แจ้งปัญหา ══════════
  const deptH = 42;
  drawBox(doc, left, y, contentW, deptH);
  const internal = isInternal(record.document_scope);
  const external = isExternal(record.document_scope);

  doc.font("Regular").fontSize(8).fillColor("#111");
  doc.text("หน่วยงานที่แจ้งปัญหา :", left + 4, y + 6, { width: 95 });

  const checkX = left + 100;
  checkbox(doc, checkX, y + 5, internal);
  doc.text("หน่วยงานภายใน จาก (แผนก)", checkX + 14, y + 5, { width: 125 });
  const fromVal = internal ? text(record.reported_by_department_name, "") : "-";
  const toVal = internal ? text(record.responsible_department_name, "") : "-";
  drawSingleLine(doc, fromVal, left + 250, y + 4, 120, { size: 9 });
  underline(doc, left + 248, y + 15, 122);
  doc.font("Regular").fontSize(8).fillColor("#111");
  doc.text("ถึง (แผนก)", left + 380, y + 5, { width: 50 });
  drawSingleLine(doc, toVal, left + 435, y + 4, 120, { size: 9 });
  underline(doc, left + 433, y + 15, 122);

  checkbox(doc, checkX, y + 24, external);
  doc.font("Regular").fontSize(8).fillColor("#111");
  doc.text("หน่วยงานภายนอก (ลูกค้า)", checkX + 14, y + 24, { width: 125 });
  const extFrom = external ? text(record.company_name, "") : "-";
  const extTo = external ? text(record.responsible_department_name, "") : "-";
  drawSingleLine(doc, extFrom, left + 250, y + 23, 120, { size: 9 });
  underline(doc, left + 248, y + 34, 122);
  doc.font("Regular").fontSize(8).fillColor("#111");
  doc.text("ถึง (แผนก)", left + 380, y + 24, { width: 50 });
  drawSingleLine(doc, extTo, left + 435, y + 23, 120, { size: 9 });
  underline(doc, left + 433, y + 34, 122);
  y += deptH;

  // ══════════ Info grid (เส้นใต้ค่า เหมือน Excel) ══════════
  const colL = contentW * 0.52;
  const colR = contentW - colL;
  const infoRows = [
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("ชื่อลูกค้า /Customer name :", x + 3, yy + 4, { width: 118 });
        drawSingleLine(doc, text(record.company_name, ""), x + 122, yy + 3, w - 128, {
          size: 9,
        });
        underline(doc, x + 120, yy + 16, w - 128);
      },
      drawRight: (x, yy, w) => {
        const labelW = 78;
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("ปัญหา / Problem", x + 3, yy + 4, {
          width: labelW,
          lineBreak: false,
        });
        const valueX = x + labelW + 4;
        const valueW = Math.max(40, w - labelW - 10);
        drawProblemSingleLine(
          doc,
          text(formatProblemLabel(record), ""),
          formatProblemNameEn(record),
          valueX,
          yy + 3,
          valueW,
        );
        underline(doc, valueX - 2, yy + 16, valueW + 2);
      },
    },
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("รายละเอียด / Description", x + 3, yy + 4, { width: 118 });
        drawSingleLine(doc, text(record.product_name, ""), x + 122, yy + 3, w - 128, {
          size: 8.5,
        });
        underline(doc, x + 120, yy + 16, w - 128);
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("จำนวนต้องการ / Q'ty", x + 3, yy + 4, { width: 95 });
        drawSingleLine(doc, formatQty(record.demand_qty), x + 100, yy + 3, 55, {
          size: 9,
        });
        underline(doc, x + 98, yy + 16, 55);
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("แผ่นเล็ก / pcs.", x + 158, yy + 5, { width: w - 164 });
      },
    },
    {
      h: 24,
      drawLeft: (x, yy, w) => {
        doc.font("Bold").fontSize(9).fillColor("#111");
        doc.text("JOB", x + 3, yy + 6, { width: 28 });
        const job = text(record.pdr_no, "");
        const boxW = Math.min(130, w - 40);
        doc.save();
        doc.rect(x + 34, yy + 3, boxW, 17).fill(YELLOW);
        doc.restore();
        drawSingleLine(doc, job, x + 36, yy + 6, boxW - 4, { font: "Bold", size: 9 });
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("จำนวนของเสีย / NG Q'ty", x + 3, yy + 5, { width: 105 });
        drawSingleLine(doc, formatQty(record.ng_qty), x + 110, yy + 4, 55, {
          size: 9,
        });
        underline(doc, x + 108, yy + 17, 55);
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("แผ่นเล็ก / pcs.", x + 168, yy + 6, { width: w - 174 });
      },
    },
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("Order / MC /MFD.", x + 3, yy + 4, { width: 85 });
        const order = text(record.order_no, "");
        const mc = text(record.machine_name, "");
        const shift = text(record.shift, "");
        drawSingleLine(doc, order, x + 90, yy + 3, 50, { size: 9 });
        underline(doc, x + 88, yy + 16, 50);
        drawSingleLine(doc, mc, x + 148, yy + 3, 70, { size: 9 });
        underline(doc, x + 146, yy + 16, 70);
        drawSingleLine(doc, shift, x + 226, yy + 3, 36, { size: 9 });
        underline(doc, x + 224, yy + 16, 36);
        void w;
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("คิดเป็นเปอร์เซนต์ / %", x + 3, yy + 4, { width: 100 });
        const pct = ngPercent(record.ng_qty, record.demand_qty);
        drawSingleLine(doc, pct, x + 108, yy + 3, 70, {
          font: "Bold",
          size: 10,
          color: RED,
        });
        underline(doc, x + 106, yy + 16, 70);
        void w;
      },
    },
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("ทีม Sale/Cs  :", x + 3, yy + 4, { width: 70 });
        drawSingleLine(doc, text(record.sale_cs_staff, ""), x + 75, yy + 3, w - 85, {
          size: 9,
        });
        underline(doc, x + 73, yy + 16, w - 85);
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("หมายเหตุ /Remark :", x + 3, yy + 4, { width: 90 });
        const remark = text(record.remark, "");
        drawSingleLine(doc, remark === "-" ? "" : remark, x + 95, yy + 3, w - 105, {
          size: 9,
        });
        underline(doc, x + 93, yy + 16, w - 105);
      },
    },
  ];

  for (const row of infoRows) {
    drawBox(doc, left, y, colL, row.h);
    drawBox(doc, left + colL, y, colR, row.h);
    row.drawLeft(left, y, colL);
    row.drawRight(left + colL, y, colR);
    y += row.h;
  }

  // ══════════ Action table ══════════
  const seqW = 72;
  const dateW = 62;
  const ownerW = 70;
  const actionW = contentW - seqW - dateW - ownerW;
  const headH = 18;
  drawBox(doc, left, y, seqW, headH, { fill: GRAY_HEADER });
  drawBox(doc, left + seqW, y, actionW, headH, { fill: GRAY_HEADER });
  drawBox(doc, left + seqW + actionW, y, dateW, headH, { fill: GRAY_HEADER });
  drawBox(doc, left + seqW + actionW + dateW, y, ownerW, headH, { fill: GRAY_HEADER });
  doc.font("Bold").fontSize(7.5).fillColor("#111");
  doc.text("ลำดับที่", left + 2, y + 5, { width: seqW - 4, align: "center" });
  doc.text("สิ่งที่จะดำเนินการจัดทำ / แก้ไข / ป้องกัน", left + seqW + 2, y + 5, {
    width: actionW - 4,
    align: "center",
  });
  doc.text("วันที่ดำเนินการ", left + seqW + actionW + 1, y + 5, {
    width: dateW - 2,
    align: "center",
  });
  doc.text("ผู้รับผิดชอบ", left + seqW + actionW + dateW + 1, y + 5, {
    width: ownerW - 2,
    align: "center",
  });
  y += headH;

  const ownerName =
    plan.contributors.find((row) => String(row.name || "").trim())?.name ||
    text(record.responsible_department_name, "");
  const actionDate = formatDateFull(record.completed_date || record.confirmed_at);

  const reservedFooter = 175;
  const actionBudget = Math.max(220, pageBottom - y - reservedFooter);
  const pictureImages = (imagesBySlot.picture || []).slice(0, 3);
  const pictureGap = 4;
  const picturePad = 3;

  // คำนวณความสูงแถว Picture จากขนาดรูปจริง (ไม่เกี่ยวกับรูปในแถวอื่น)
  // จัดชิดซ้ายเหมือน Preview — ไม่แบ่งช่องกลาง / ไม่บังคับ scale ≤ 1
  let pictureH = 48;
  if (pictureImages.length) {
    const count = pictureImages.length;
    const maxAllowedH = Math.round(actionBudget * 0.3);
    const availW = actionW - picturePad * 2 - pictureGap * Math.max(0, count - 1);
    const maxW = availW / count;
    let neededH = 0;
    for (const attachment of pictureImages) {
      const buffer = loadImage(attachment);
      if (!buffer) continue;
      try {
        const img = doc.openImage(buffer);
        const scale = Math.min(maxW / img.width, maxAllowedH / img.height);
        neededH = Math.max(neededH, img.height * scale);
      } catch {
        neededH = Math.max(neededH, 72);
      }
    }
    pictureH = Math.ceil(neededH + picturePad * 2);
    pictureH = Math.min(Math.max(pictureH, 52), maxAllowedH + picturePad * 2);
  }
  const textH = Math.floor((actionBudget - pictureH) / 3);

  const sections = [
    {
      title: "Picture",
      sub: "( รูปภาพ )",
      body: "",
      slot: "picture",
      isPicture: true,
      h: pictureH,
    },
    {
      title: "Root cause",
      sub: "(สาเหตุ)",
      body: text(record.cause, ""),
      slot: "cause",
      h: textH,
    },
    {
      title: "Corrective Action",
      sub: "(การแก้ไขเบื้องต้น)",
      body: text(record.correction, ""),
      slot: "correction",
      h: textH,
    },
    {
      title: "Preventive Action",
      sub: "(การป้องกันไม่ให้เกิดซ้ำ)",
      body: text(record.prevention, ""),
      slot: "prevention",
      h: textH,
    },
  ];

  const drawSlotImages = (
    slotImages,
    boxX,
    boxY,
    boxW,
    boxH,
    { topPad = 4, direction = "row", fillHeight = false } = {},
  ) => {
    const count = Math.min(slotImages.length, 3);
    if (!count) return 0;
    const gap = 4;

    if (direction === "column") {
      const imgH = (boxH - topPad - gap * (count + 1)) / count;
      const imgW = boxW - gap * 2;
      for (let i = 0; i < count; i += 1) {
        const buffer = loadImage(slotImages[i]);
        if (!buffer) continue;
        try {
          doc.image(buffer, boxX + gap, boxY + topPad + gap + i * (imgH + gap), {
            fit: [imgW, imgH],
            align: "center",
            valign: "center",
          });
        } catch {
          /* skip */
        }
      }
      return boxH;
    }

    // Picture row: ใช้ความสูงช่องเกือบเต็ม / แถวอื่น: จำกัดขนาดไม่ให้ใหญ่เกิน
    const maxH = fillHeight
      ? Math.max(24, boxH - topPad * 2)
      : count >= 3
        ? Math.min(boxH - topPad - 4, 52)
        : Math.min(boxH - topPad - 4, 72);
    const imgW = (boxW - gap * (count + 1)) / count;
    const imgH = maxH;
    const offsetY = fillHeight
      ? boxY + Math.max(topPad, (boxH - imgH) / 2)
      : boxY + topPad;
    for (let i = 0; i < count; i += 1) {
      const buffer = loadImage(slotImages[i]);
      if (!buffer) continue;
      try {
        doc.image(buffer, boxX + gap + i * (imgW + gap), offsetY, {
          fit: [imgW, imgH],
          align: "center",
          valign: "center",
        });
      } catch {
        /* skip */
      }
    }
    return imgH + topPad;
  };

  for (const section of sections) {
    drawBox(doc, left, y, seqW, section.h);
    drawBox(doc, left + seqW, y, actionW, section.h);
    drawBox(doc, left + seqW + actionW, y, dateW, section.h);
    drawBox(doc, left + seqW + actionW + dateW, y, ownerW, section.h);

    // จัด title + sub เป็นบล็อกเดียวตรงกลางช่อง — วัดความสูงจริงกันข้อความทับกัน
    const labelW = seqW - 4;
    doc.font("Bold").fontSize(7).fillColor("#111");
    const titleH = doc.heightOfString(section.title, {
      width: labelW,
      align: "center",
      lineGap: 1,
    });
    doc.font("Regular").fontSize(6).fillColor("#444");
    const subH = doc.heightOfString(section.sub, {
      width: labelW,
      align: "center",
      lineGap: 0,
    });
    const labelGap = 3;
    const blockH = titleH + labelGap + subH;
    const labelY = y + Math.max(3, (section.h - blockH) / 2);
    doc.font("Bold").fontSize(7).fillColor("#111");
    doc.text(section.title, left + 2, labelY, {
      width: labelW,
      align: "center",
      lineGap: 1,
    });
    doc.font("Regular").fontSize(6).fillColor("#444");
    doc.text(section.sub, left + 2, labelY + titleH + labelGap, {
      width: labelW,
      align: "center",
      lineGap: 0,
    });

    const slotImages = section.slot ? imagesBySlot[section.slot] || [] : [];

    if (section.isPicture) {
      // วาดรูปชิดซ้าย + ชิดบน (ให้ใกล้ขอบช่องเหมือน Preview)
      const count = Math.min(slotImages.length, 3);
      if (count) {
        const maxDrawH = section.h - picturePad * 2;
        const availW =
          actionW - picturePad * 2 - pictureGap * Math.max(0, count - 1);
        const maxW = availW / count;
        let cursorX = left + seqW + picturePad;
        for (let i = 0; i < count; i += 1) {
          const buffer = loadImage(slotImages[i]);
          if (!buffer) continue;
          try {
            const img = doc.openImage(buffer);
            const scale = Math.min(maxW / img.width, maxDrawH / img.height);
            const drawW = img.width * scale;
            const drawH = img.height * scale;
            doc.image(buffer, cursorX, y + picturePad, {
              width: drawW,
              height: drawH,
            });
            cursorX += drawW + pictureGap;
          } catch {
            /* skip */
          }
        }
      }
      // วันที่ / ผู้รับผิดชอบ ของแถว Picture ว่างตาม Excel
    } else {
      const hasImages = slotImages.length > 0;
      const gap = 6;
      // รูปซ้าย · ข้อความขวา (แนวนอน)
      const imageColW = hasImages
        ? Math.min(
            actionW * (slotImages.length >= 3 ? 0.48 : 0.42),
            slotImages.length >= 3 ? 168 : 140,
          )
        : 0;
      const textColX = left + seqW + (hasImages ? imageColW + gap : 0);
      const textColW = actionW - (hasImages ? imageColW + gap : 0);

      if (hasImages) {
        drawSlotImages(slotImages, left + seqW, y, imageColW, section.h, {
          topPad: 4,
          direction: slotImages.length > 1 ? "column" : "row",
        });
      }

      // เส้นบรรทัดในช่องข้อความ เหมือน Excel
      const lineCount = 4;
      const lineGap = Math.max(10, (section.h - 8) / lineCount);
      for (let i = 1; i <= lineCount; i += 1) {
        const ly = y + 4 + i * lineGap;
        if (ly < y + section.h - 2) {
          underline(doc, textColX + 4, ly, textColW - 8);
        }
      }
      doc.font("Regular").fontSize(8.5).fillColor("#111");
      doc.text(section.body === "-" ? "" : section.body, textColX + 5, y + 5, {
        width: textColW - 10,
        height: section.h - 10,
        ellipsis: true,
      });

      doc.font("Regular").fontSize(8);
      doc.text(actionDate, left + seqW + actionW + 2, y + section.h / 2 - 5, {
        width: dateW - 4,
        align: "center",
      });
      doc.text(ownerName === "-" ? "" : ownerName, left + seqW + actionW + dateW + 2, y + section.h / 2 - 5, {
        width: ownerW - 4,
        align: "center",
      });
    }
    y += section.h;
  }

  // ══════════ Footer 3 คอลัมน์ ══════════
  const footerH = Math.max(pageBottom - y, 150);
  const contribW = contentW * 0.42;
  const approvalW = contentW * 0.22;
  const followW = contentW - contribW - approvalW;
  const approvalX = left + contribW;
  const followX = left + contribW + approvalW;

  drawBox(doc, left, y, contribW, footerH);
  drawBox(doc, approvalX, y, approvalW, footerH);
  drawBox(doc, followX, y, followW, footerH);

  // Contributors header
  const cHeadH = 16;
  doc.save();
  doc.rect(left, y, contribW, cHeadH).fill(GRAY_HEADER);
  doc.restore();
  doc.rect(left, y, contribW, cHeadH).stroke(LINE);
  doc.font("Bold").fontSize(8).fillColor("#111");
  doc.text("ผู้ร่วมจัดทำแผน", left, y + 4, { width: contribW, align: "center" });

  const nameW = contribW * 0.4;
  const posW = contribW * 0.32;
  const sigW = contribW - nameW - posW;
  const subHeadY = y + cHeadH;
  const subHeadH = 14;
  drawBox(doc, left, subHeadY, nameW, subHeadH, { fill: "#F3F3F3" });
  drawBox(doc, left + nameW, subHeadY, posW, subHeadH, { fill: "#F3F3F3" });
  drawBox(doc, left + nameW + posW, subHeadY, sigW, subHeadH, { fill: "#F3F3F3" });
  doc.font("Regular").fontSize(7);
  doc.text("ชื่อ - สกุล", left + 2, subHeadY + 3, { width: nameW - 4 });
  doc.text("ตำแหน่ง", left + nameW + 2, subHeadY + 3, { width: posW - 4 });
  doc.text("ลงชื่อ", left + nameW + posW + 2, subHeadY + 3, {
    width: sigW - 4,
    align: "center",
  });

  const rows = plan.contributors.filter(
    (row) =>
      String(row.name || "").trim() ||
      String(row.position || "").trim() ||
      row.signatureId,
  );
  const displayRows = Array.from({ length: 4 }, (_, i) => rows[i] || {
    name: "",
    position: "",
    signatureId: null,
  });
  const rowH = (footerH - cHeadH - subHeadH) / displayRows.length;
  let ry = subHeadY + subHeadH;
  for (const row of displayRows) {
    drawBox(doc, left, ry, nameW, rowH);
    drawBox(doc, left + nameW, ry, posW, rowH);
    drawBox(doc, left + nameW + posW, ry, sigW, rowH);
    doc.font("Regular").fontSize(8).fillColor("#111");
    doc.text(text(row.name, ""), left + 3, ry + rowH / 2 - 5, { width: nameW - 6 });
    doc.text(text(row.position, ""), left + nameW + 3, ry + rowH / 2 - 5, {
      width: posW - 6,
    });
    const sigBuf = loadImage(attachmentById.get(Number(row.signatureId)));
    if (sigBuf) {
      drawSignature(doc, sigBuf, left + nameW + posW, ry, sigW, rowH, {
        pad: 2,
      });
    }
    ry += rowH;
  }

  // Approvals middle — ไม่มีหัวคอลัมน์ / ไม่มีเส้นแบ่ง
  const approvalRoles = [
    { key: "production_specialist", label: "ผู้เชี่ยวชาญการผลิต" },
    { key: "qa_deputy", label: "รองผู้จัดการฝ่ายประกันคุณภาพ" },
  ];
  const boxH = footerH / approvalRoles.length;
  let ay = y;
  for (const role of approvalRoles) {
    const approval = plan.approvals?.[role.key];
    const sigBuf = loadImage(
      attachmentById.get(Number(approval?.signatureId)),
    );
    // พื้นที่ลายเซ็น: เกือบเต็มความกว้าง / สูงถึงเหนือเส้นชื่อบทบาท
    const sigBoxX = approvalX + 4;
    const sigBoxY = ay + 4;
    const sigBoxW = approvalW - 8;
    const sigBoxH = boxH - 22;
    if (sigBuf) {
      drawSignature(doc, sigBuf, sigBoxX, sigBoxY, sigBoxW, sigBoxH, {
        pad: 2,
      });
    }
    const heading = String(approval?.position || "").trim() || role.label;
    dottedLine(doc, approvalX + 10, ay + boxH - 16, approvalW - 20);
    doc.font("Regular").fontSize(7).fillColor("#333");
    doc.text(heading, approvalX + 2, ay + boxH - 13, {
      width: approvalW - 4,
      align: "center",
    });
    ay += boxH;
  }

  // Follow-up right
  doc.save();
  doc.rect(followX, y, followW, cHeadH).fill(GRAY_HEADER);
  doc.restore();
  doc.rect(followX, y, followW, cHeadH).stroke(LINE);
  doc.font("Bold").fontSize(7.5).fillColor("#111");
  doc.text("บันทึกการติดตามผลการแก้ไขปัญหา", followX, y + 4, {
    width: followW,
    align: "center",
  });

  const noteTop = y + cHeadH + 18;
  const noteBottom = y + footerH - 48;
  const noteCount = 4;
  const noteGap = (noteBottom - noteTop) / Math.max(noteCount - 1, 1);
  for (let i = 0; i < noteCount; i += 1) {
    underline(doc, followX + 8, noteTop + i * noteGap, followW - 16);
  }

  const signY = y + footerH - 40;
  // จัดช่อง: [บทบาท] ……ลงชื่อ…… [วันที่] ……วันที่……
  const roleLabelW = 48;
  const dateLabelW = 28;
  const colGap = 8;
  const dateColX = followX + Math.round(followW * 0.58);
  const sigLineX = followX + 6 + roleLabelW;
  const sigLineW = Math.max(24, dateColX - colGap - sigLineX);
  const dateLineX = dateColX + dateLabelW;
  const dateLineW = Math.max(20, followX + followW - 8 - dateLineX);

  doc.font("Regular").fontSize(7).fillColor("#333");
  doc.text("ผู้ตรวจสอบ", followX + 6, signY, { width: roleLabelW, lineBreak: false });
  dottedLine(doc, sigLineX, signY + 8, sigLineW);
  doc.text("วันที่", dateColX, signY, { width: dateLabelW, lineBreak: false });
  dottedLine(doc, dateLineX, signY + 8, dateLineW);

  doc.text("ผู้ทบทวน", followX + 6, signY + 14, { width: roleLabelW, lineBreak: false });
  dottedLine(doc, sigLineX, signY + 22, sigLineW);
  doc.text("วันที่", dateColX, signY + 14, { width: dateLabelW, lineBreak: false });
  dottedLine(doc, dateLineX, signY + 22, dateLineW);

  doc.font("Regular").fontSize(7).fillColor("#444");
  doc.text("หัวหน้าแผนก QA", followX, signY + 28, {
    width: followW,
    align: "center",
  });

  // รหัสฟอร์มท้ายหน้า เหมือน Excel
  doc.font("Regular").fontSize(6).fillColor("#555");
  doc.text("LFB-QAD-FM-011/REV.NO.03", left, pageH - margin - 8, {
    width: contentW,
    align: "right",
  });

  doc.end();
  const buffer = await done;
  return {
    buffer,
    filename: buildFilename(record),
    contentType: "application/pdf",
  };
}

export function canExportActionPlan(record) {
  return (
    String(record?.document_accepted || "").toUpperCase() === "P" &&
    String(record?.workflow_status || "") === "completed"
  );
}
