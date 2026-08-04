import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { normalizePlanForm, groupImagesByPdfSlot } from "./plan-form.js";

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

function text(value, fallback = "-") {
  const raw = value == null ? "" : String(value).trim();
  return raw || fallback;
}

function formatDateShort(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const d = String(date.getDate());
  const m = String(date.getMonth() + 1);
  const y = String(date.getFullYear()).slice(-2);
  return `${d}/${m}/${y}`;
}

function formatDateFull(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

function formatQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return text(value, "");
  return number.toLocaleString("en-US");
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

  const loadImage = (attachment) => {
    if (!attachment || !uploadsDirectory) return null;
    const filePath = resolve(uploadsDirectory, attachment.stored_name);
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath);
    } catch {
      return null;
    }
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

  const logoFile = existsSync(LOGO_EXCEL_PATH)
    ? LOGO_EXCEL_PATH
    : existsSync(LOGO_PATH)
      ? LOGO_PATH
      : null;
  if (logoFile) {
    try {
      doc.image(logoFile, left + 6, y + 6, { height: 28, fit: [36, 28] });
    } catch {
      /* ignore */
    }
  }
  doc.font("Bold").fontSize(9).fillColor("#111");
  doc.text("LEE FIBREBOARD", left + 46, y + 10, { width: logoW - 52 });
  doc.font("Regular").fontSize(7).fillColor("#333");
  doc.text("บริษัท ลีไฟเบอร์บอร์ด จำกัด", left + 46, y + 24, { width: logoW - 52 });

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
  doc.font("Regular").fontSize(9);
  doc.text(fromVal, left + 250, y + 4, { width: 120 });
  underline(doc, left + 248, y + 15, 122);
  doc.font("Regular").fontSize(8);
  doc.text("ถึง (แผนก)", left + 380, y + 5, { width: 50 });
  doc.font("Regular").fontSize(9);
  doc.text(toVal, left + 435, y + 4, { width: 120 });
  underline(doc, left + 433, y + 15, 122);

  checkbox(doc, checkX, y + 24, external);
  doc.font("Regular").fontSize(8);
  doc.text("หน่วยงานภายนอก (ลูกค้า)", checkX + 14, y + 24, { width: 125 });
  const extFrom = external ? text(record.company_name, "") : "-";
  const extTo = external ? text(record.responsible_department_name, "") : "-";
  doc.font("Regular").fontSize(9);
  doc.text(extFrom, left + 250, y + 23, { width: 120 });
  underline(doc, left + 248, y + 34, 122);
  doc.font("Regular").fontSize(8);
  doc.text("ถึง (แผนก)", left + 380, y + 24, { width: 50 });
  doc.font("Regular").fontSize(9);
  doc.text(extTo, left + 435, y + 23, { width: 120 });
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
        doc.font("Regular").fontSize(9);
        doc.text(text(record.company_name, ""), x + 122, yy + 3, { width: w - 128 });
        underline(doc, x + 120, yy + 16, w - 128);
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("ปัญหา / Problem", x + 3, yy + 4, { width: 78 });
        doc.font("Regular").fontSize(9);
        doc.text(text(record.problem_name, ""), x + 82, yy + 3, { width: 70 });
        if (record.problem_name_en) {
          doc.fillColor(RED).text(String(record.problem_name_en), x + 155, yy + 3, {
            width: w - 160,
          });
          doc.fillColor("#111");
        }
        underline(doc, x + 80, yy + 16, w - 86);
      },
    },
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("รายละเอียด / Description", x + 3, yy + 4, { width: 118 });
        doc.font("Regular").fontSize(8.5);
        doc.text(text(record.product_name, ""), x + 122, yy + 3, {
          width: w - 128,
          height: 14,
          ellipsis: true,
        });
        underline(doc, x + 120, yy + 16, w - 128);
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("จำนวนต้องการ / Q'ty", x + 3, yy + 4, { width: 95 });
        doc.font("Regular").fontSize(9);
        doc.text(formatQty(record.demand_qty), x + 100, yy + 3, { width: 55 });
        underline(doc, x + 98, yy + 16, 55);
        doc.font("Regular").fontSize(7.5);
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
        doc.font("Bold").fontSize(9).fillColor("#111");
        doc.text(job, x + 36, yy + 6, { width: boxW - 4 });
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("จำนวนของเสีย / NG Q'ty", x + 3, yy + 5, { width: 105 });
        doc.font("Regular").fontSize(9);
        doc.text(formatQty(record.ng_qty), x + 110, yy + 4, { width: 55 });
        underline(doc, x + 108, yy + 17, 55);
        doc.font("Regular").fontSize(7.5);
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
        doc.font("Regular").fontSize(9);
        doc.text(order, x + 90, yy + 3, { width: 50 });
        underline(doc, x + 88, yy + 16, 50);
        doc.text(mc, x + 148, yy + 3, { width: 70 });
        underline(doc, x + 146, yy + 16, 70);
        doc.text(shift, x + 226, yy + 3, { width: 36 });
        underline(doc, x + 224, yy + 16, 36);
        void w;
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("คิดเป็นเปอร์เซนต์ / %", x + 3, yy + 4, { width: 100 });
        const pct = ngPercent(record.ng_qty, record.demand_qty);
        doc.font("Bold").fontSize(10).fillColor(RED);
        doc.text(pct, x + 108, yy + 3, { width: 70 });
        doc.fillColor("#111");
        underline(doc, x + 106, yy + 16, 70);
        void w;
      },
    },
    {
      h: 22,
      drawLeft: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("ทีม Sale/Cs  :", x + 3, yy + 4, { width: 70 });
        doc.font("Regular").fontSize(9);
        doc.text(text(record.sale_cs_staff, ""), x + 75, yy + 3, { width: w - 85 });
        underline(doc, x + 73, yy + 16, w - 85);
      },
      drawRight: (x, yy, w) => {
        doc.font("Regular").fontSize(7.5).fillColor("#111");
        doc.text("หมายเหตุ /Remark :", x + 3, yy + 4, { width: 90 });
        doc.font("Regular").fontSize(9);
        const remark = text(record.remark, "");
        doc.text(remark === "-" ? "" : remark, x + 95, yy + 3, { width: w - 105 });
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
  const seqW = 58;
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
  const pictureGap = 6;
  const picturePad = 6;

  // คำนวณความสูงแถว Picture จากขนาดรูปจริง (ไม่เกี่ยวกับรูปในแถวอื่น)
  let pictureH = 48;
  if (pictureImages.length) {
    const cellW =
      (actionW - pictureGap * (pictureImages.length + 1)) / pictureImages.length;
    const maxAllowedH = Math.round(actionBudget * 0.3);
    let neededH = 0;
    for (const attachment of pictureImages) {
      const buffer = loadImage(attachment);
      if (!buffer) continue;
      try {
        const img = doc.openImage(buffer);
        const scale = Math.min(cellW / img.width, maxAllowedH / img.height, 1);
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

    doc.font("Bold").fontSize(8).fillColor("#111");
    doc.text(section.title, left + 2, y + section.h / 2 - 10, {
      width: seqW - 4,
      align: "center",
    });
    doc.font("Regular").fontSize(7).fillColor("#444");
    doc.text(section.sub, left + 2, y + section.h / 2 + 2, {
      width: seqW - 4,
      align: "center",
    });

    const slotImages = section.slot ? imagesBySlot[section.slot] || [] : [];

    if (section.isPicture) {
      // วาดรูปชิดบนตามขนาดจริง — ไม่จัดกลางแนวตั้งเพื่อไม่ให้ดูเหมือนเว้นช่องว่าง
      const count = Math.min(slotImages.length, 3);
      if (count) {
        const cellW = (actionW - pictureGap * (count + 1)) / count;
        const maxDrawH = section.h - picturePad * 2;
        for (let i = 0; i < count; i += 1) {
          const buffer = loadImage(slotImages[i]);
          if (!buffer) continue;
          try {
            const img = doc.openImage(buffer);
            const scale = Math.min(cellW / img.width, maxDrawH / img.height, 1);
            const drawW = img.width * scale;
            const drawH = img.height * scale;
            const x =
              left + seqW + pictureGap + i * (cellW + pictureGap) + (cellW - drawW) / 2;
            const iy = y + picturePad;
            doc.image(buffer, x, iy, { width: drawW, height: drawH });
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
      try {
        doc.image(sigBuf, left + nameW + posW + 2, ry + 2, {
          fit: [sigW - 4, rowH - 4],
          align: "center",
          valign: "center",
        });
      } catch {
        /* ignore */
      }
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
    const sigBuf = loadImage(
      attachmentById.get(Number(plan.approvals?.[role.key]?.signatureId)),
    );
    const imgW = Math.min(approvalW - 14, 100);
    const imgH = Math.min(boxH - 28, 70);
    if (sigBuf) {
      try {
        doc.image(sigBuf, approvalX + (approvalW - imgW) / 2, ay + 8, {
          fit: [imgW, imgH],
          align: "center",
          valign: "center",
        });
      } catch {
        /* ignore */
      }
    }
    dottedLine(doc, approvalX + 10, ay + boxH - 16, approvalW - 20);
    doc.font("Regular").fontSize(7).fillColor("#333");
    doc.text(role.label, approvalX + 2, ay + boxH - 13, {
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
  doc.font("Regular").fontSize(7).fillColor("#333");
  doc.text("ผู้ตรวจสอบ", followX + 6, signY, { width: 42 });
  dottedLine(doc, followX + 50, signY + 8, followW * 0.38);
  doc.text("วันที่", followX + followW * 0.55, signY, { width: 24 });
  dottedLine(doc, followX + followW * 0.55 + 26, signY + 8, followW * 0.28);

  doc.text("ผู้ทบทวน", followX + 6, signY + 14, { width: 42 });
  dottedLine(doc, followX + 50, signY + 22, followW * 0.38);
  doc.text("วันที่", followX + followW * 0.55, signY + 14, { width: 24 });
  dottedLine(doc, followX + followW * 0.55 + 26, signY + 22, followW * 0.28);

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
