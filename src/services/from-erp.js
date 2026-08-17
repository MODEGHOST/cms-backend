import { createErpPdrClient } from "./erp-pdr.js";
import { parseFluteFromSize } from "../utils/parse-flute-from-size.js";

/** อ่านอย่างเดียวจาก ERP — เขียนเฉพาะ CMS */
function toDate(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function toText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInt(value) {
  const number = toNumber(value);
  return number == null ? null : Math.trunc(number);
}

/** ฟิลด์ใบ Tag จากแถว ERP หรือ draft — อ่านอย่างเดียว ไม่เขียนกลับ ERP */
function pickRejectTagFields(row) {
  return {
    cutQty: toInt(row?.cut_qty ?? row?.t),
    itemCode: toText(row?.item_code ?? row?.item_no),
    bigSheetQty: toNumber(row?.big_sheet_qty ?? row?.big_sheet),
    bigSheetSize: toText(row?.big_sheet_size),
    smallSheetSize: toText(row?.small_sheet_size),
  };
}

/** flute จาก ERP ก่อน — ถ้าไม่มี ดึงอักษรท้ายจาก Size (เช่น ... CA125 B → B) */
async function resolveRejectFluteId(rejects, fluteName, size) {
  const fromErp = await rejects.resolveFluteId(fluteName);
  if (fromErp) return fromErp;
  const fromSize = parseFluteFromSize(size);
  if (!fromSize) return null;
  return rejects.resolveFluteId(fromSize);
}

export function createFromErpService({
  config,
  complaints,
  rejects,
  activityLogs,
}) {
  const erp = createErpPdrClient({ config });

  async function fetchErpRow(pdrNo) {
    const result = await erp.getByPdrNo(pdrNo);
    if (!result.enabled) {
      const error = new Error(
        "ยังไม่ได้เปิด ERP (ตั้ง ERP_API_ENABLED=1 และรัน Beta_api_erp)",
      );
      error.status = 503;
      throw error;
    }
    if (!result.ok) {
      const error = new Error(result.error || "เรียก ERP ไม่สำเร็จ");
      error.status = 502;
      throw error;
    }
    const row = result.data?.[0];
    if (!row) {
      const error = new Error("ไม่พบเลข PDR นี้ใน ERP");
      error.status = 404;
      throw error;
    }
    return row;
  }

  return {
    async findOrCreateComplaint(pdrNo, actor) {
      const trimmed = String(pdrNo || "").trim();
      if (!trimmed) {
        const error = new Error("กรุณาระบุ pdr_no");
        error.status = 400;
        throw error;
      }

      const existing = await complaints.findByPdr(trimmed);
      if (existing.length) {
        return {
          data: existing,
          total: existing.length,
          pdr_no: trimmed,
          created: false,
          from_erp: false,
        };
      }

      const erpRow = await fetchErpRow(trimmed);
      const companyId = await complaints.resolveCompanyId(erpRow.company_name);
      const customerAliasId = await complaints.resolveAliasId(
        companyId,
        erpRow.customer_alias_name,
      );
      const fluteId = await complaints.resolveFluteId(erpRow.flute_name);
      const machineId = await complaints.resolveMachineId(erpRow.machine_name);

      const insertId = await complaints.createFromErp({
        pdrNo: trimmed,
        companyId,
        customerAliasId,
        fluteId,
        machineId,
        orderNo: toText(erpRow.order_no),
        productName: toText(erpRow.product_name),
        paperM5: toText(erpRow.paper_m5),
        paperM4: toText(erpRow.paper_m4),
        paperM3: toText(erpRow.paper_m3),
        paperM2: toText(erpRow.paper_m2),
        paperM1: toText(erpRow.paper_m1),
        planNo: toText(erpRow.plan_no),
        shift: toText(erpRow.shift),
        deliveryDate: toDate(erpRow.delivery_date),
        productionDate: toDate(erpRow.production_date),
        demandQty: toNumber(erpRow.demand_qty),
        grade: toText(erpRow.grade),
        saleCsStaff: toText(erpRow.sale_cs_staff),
        createdBy: actor?.id || null,
      });

      if (activityLogs) {
        await activityLogs.create({
          userId: actor?.id || null,
          username: actor?.username || null,
          displayName: actor?.display_name || null,
          department: actor?.department || null,
          action: "create",
          entityType: "complaint_record",
          entityId: insertId,
          summary: `สร้าง Complaint จาก ERP ${trimmed}`,
          changes: [{ field: "pdr_no", label: "PDR", before: null, after: trimmed }],
        });
      }

      const record = await complaints.findById(insertId);
      return {
        data: record ? [record] : [],
        total: record ? 1 : 0,
        pdr_no: trimmed,
        created: true,
        from_erp: true,
      };
    },

    /**
     * INSERT Complaint จากข้อมูลในฟอร์มหลัง Search แล้ว — ไม่เรียก ERP ซ้ำ
     */
    async createComplaintFromDraft(payload, actor) {
      const trimmed = String(payload?.pdr_no || "").trim();
      if (!trimmed) {
        const error = new Error("กรุณาระบุ pdr_no");
        error.status = 400;
        throw error;
      }

      const existing = await complaints.findByPdr(trimmed);
      if (existing.length) {
        return {
          data: existing,
          total: existing.length,
          pdr_no: trimmed,
          created: false,
          from_erp: false,
        };
      }

      const companyId = await complaints.resolveCompanyId(payload.company_name);
      const customerAliasId = await complaints.resolveAliasId(
        companyId,
        payload.customer_alias_name,
      );
      const fluteId = await complaints.resolveFluteId(payload.flute_name);
      const machineId = await complaints.resolveMachineId(payload.machine_name);

      const insertId = await complaints.createFromErp({
        pdrNo: trimmed,
        companyId,
        customerAliasId,
        fluteId,
        machineId,
        orderNo: toText(payload.order_no),
        productName: toText(payload.product_name),
        paperM5: toText(payload.paper_m5),
        paperM4: toText(payload.paper_m4),
        paperM3: toText(payload.paper_m3),
        paperM2: toText(payload.paper_m2),
        paperM1: toText(payload.paper_m1),
        planNo: toText(payload.plan_no),
        shift: toText(payload.shift),
        deliveryDate: toDate(payload.delivery_date || payload.customer_ship_date),
        productionDate: toDate(payload.production_date),
        demandQty: toNumber(payload.demand_qty),
        grade: toText(payload.grade),
        saleCsStaff: toText(payload.sale_cs_staff),
        createdBy: actor?.id || null,
      });

      if (activityLogs) {
        await activityLogs.create({
          userId: actor?.id || null,
          username: actor?.username || null,
          displayName: actor?.display_name || null,
          department: actor?.department || null,
          action: "create",
          entityType: "complaint_record",
          entityId: insertId,
          summary: `สร้าง Complaint จากข้อมูลฟอร์ม ${trimmed}`,
          changes: [{ field: "pdr_no", label: "PDR", before: null, after: trimmed }],
        });
      }

      const record = await complaints.findById(insertId);
      return {
        data: record ? [record] : [],
        total: record ? 1 : 0,
        pdr_no: trimmed,
        created: true,
        from_erp: false,
      };
    },

    async findOrCreateReject(pdrNo, actor) {
      const trimmed = String(pdrNo || "").trim();
      if (!trimmed) {
        const error = new Error("กรุณาระบุ pdr_no");
        error.status = 400;
        throw error;
      }

      const existing = await rejects.findByPdr(trimmed);
      if (existing.length) {
        return {
          data: existing,
          total: existing.length,
          pdr_no: trimmed,
          created: false,
          from_erp: false,
        };
      }

      const erpRow = await fetchErpRow(trimmed);
      const companyId = await rejects.resolveCompanyId(erpRow.company_name);
      const customerAliasId = await rejects.resolveAliasId(
        companyId,
        erpRow.customer_alias_name,
      );
      const machineId = await rejects.resolveMachineId(erpRow.machine_name);
      // Size ในฟอร์ม Reject = Description จาก ERP (API ส่งเป็น product_name)
      const size = toText(erpRow.description || erpRow.product_name);
      const fluteId = await resolveRejectFluteId(
        rejects,
        erpRow.flute_name,
        size,
      );

      const tag = pickRejectTagFields(erpRow);
      const insertId = await rejects.createFromErp({
        pdrNo: trimmed,
        companyId,
        customerAliasId,
        machineId,
        fluteId,
        saleOrderNo: toText(erpRow.sale_order_no),
        orderQty: toNumber(erpRow.order_qty ?? erpRow.demand_qty),
        size,
        cutQty: tag.cutQty,
        itemCode: tag.itemCode,
        bigSheetQty: tag.bigSheetQty,
        bigSheetSize: tag.bigSheetSize,
        smallSheetSize: tag.smallSheetSize,
        shift: toText(erpRow.shift),
        vehiclePlate: toText(erpRow.vehicle_plate),
        customerShipDate: toDate(
          erpRow.customer_ship_date || erpRow.delivery_date,
        ),
        productionDate: toDate(erpRow.production_date),
        weightPerSheet: toNumber(erpRow.weight_per_sheet),
        pricePerSheet: toNumber(erpRow.price_per_sheet),
        createdBy: actor?.id || null,
      });

      if (activityLogs) {
        await activityLogs.create({
          userId: actor?.id || null,
          username: actor?.username || null,
          displayName: actor?.display_name || null,
          department: actor?.department || null,
          action: "create",
          entityType: "reject_record",
          entityId: insertId,
          summary: `สร้าง Reject จาก ERP ${trimmed}`,
          changes: [{ field: "pdr_no", label: "PDR", before: null, after: trimmed }],
        });
      }

      const record = await rejects.findById(insertId);
      return {
        data: record ? [record] : [],
        total: record ? 1 : 0,
        pdr_no: trimmed,
        created: true,
        from_erp: true,
      };
    },

    /**
     * INSERT Reject จากข้อมูลในฟอร์มหลัง Search แล้ว — ไม่เรียก ERP ซ้ำ
     */
    async createRejectFromDraft(payload, actor) {
      const trimmed = String(payload?.pdr_no || "").trim();
      if (!trimmed) {
        const error = new Error("กรุณาระบุ pdr_no");
        error.status = 400;
        throw error;
      }

      const existing = await rejects.findByPdr(trimmed);
      if (existing.length) {
        return {
          data: existing,
          total: existing.length,
          pdr_no: trimmed,
          created: false,
          from_erp: false,
        };
      }

      const companyId = await rejects.resolveCompanyId(payload.company_name);
      const customerAliasId = await rejects.resolveAliasId(
        companyId,
        payload.customer_alias_name,
      );
      const machineId = await rejects.resolveMachineId(payload.machine_name);
      const size = toText(
        payload.size || payload.description || payload.product_name,
      );
      const fluteId = await resolveRejectFluteId(
        rejects,
        payload.flute_name,
        size,
      );

      const tag = pickRejectTagFields(payload);
      const insertId = await rejects.createFromErp({
        pdrNo: trimmed,
        companyId,
        customerAliasId,
        machineId,
        fluteId,
        saleOrderNo: toText(payload.sale_order_no),
        orderQty: toNumber(payload.order_qty ?? payload.demand_qty),
        size,
        cutQty: tag.cutQty,
        itemCode: tag.itemCode,
        bigSheetQty: tag.bigSheetQty,
        bigSheetSize: tag.bigSheetSize,
        smallSheetSize: tag.smallSheetSize,
        shift: toText(payload.shift),
        vehiclePlate: toText(payload.vehicle_plate),
        customerShipDate: toDate(
          payload.customer_ship_date || payload.delivery_date,
        ),
        productionDate: toDate(payload.production_date),
        weightPerSheet: toNumber(payload.weight_per_sheet),
        pricePerSheet: toNumber(payload.price_per_sheet),
        createdBy: actor?.id || null,
      });

      if (activityLogs) {
        await activityLogs.create({
          userId: actor?.id || null,
          username: actor?.username || null,
          displayName: actor?.display_name || null,
          department: actor?.department || null,
          action: "create",
          entityType: "reject_record",
          entityId: insertId,
          summary: `สร้าง Reject จากข้อมูลฟอร์ม ${trimmed}`,
          changes: [{ field: "pdr_no", label: "PDR", before: null, after: trimmed }],
        });
      }

      const record = await rejects.findById(insertId);
      return {
        data: record ? [record] : [],
        total: record ? 1 : 0,
        pdr_no: trimmed,
        created: true,
        from_erp: false,
      };
    },

    /**
     * เติมช่อง ERP ที่ว่างบน Reject ที่มีอยู่แล้ว (GET ERP อย่างเดียว — ไม่เขียนกลับ ERP)
     * ใช้ตอน QC เปิดฟอร์มใบที่มาจาก Complaint stub
     */
    async enrichRejectFromErp(id, actor) {
      const current = await rejects.findById(id);
      if (!current) {
        const error = new Error("ไม่พบรายการ Reject");
        error.status = 404;
        throw error;
      }

      const pdrNo = String(current.pdr_no || "").trim();
      if (!pdrNo) {
        const error = new Error("รายการนี้ยังไม่มีเลข PDR");
        error.status = 400;
        throw error;
      }

      const erpRow = await fetchErpRow(pdrNo);
      const updates = {};
      const changes = [];

      const companyId = await rejects.resolveCompanyId(erpRow.company_name);
      const customerAliasId = await rejects.resolveAliasId(
        companyId || current.company_id,
        erpRow.customer_alias_name,
      );
      const machineId = await rejects.resolveMachineId(erpRow.machine_name);
      const sizeFromErp = toText(erpRow.description || erpRow.product_name);
      const fluteId = await resolveRejectFluteId(
        rejects,
        erpRow.flute_name,
        sizeFromErp || current.size,
      );

      function setIfEmpty(column, nextValue, label) {
        if (nextValue == null || nextValue === "") return;
        const before = current[column];
        if (before != null && before !== "") return;
        updates[column] = nextValue;
        changes.push({
          field: column,
          label,
          before: "(ว่าง)",
          after: String(nextValue),
        });
      }

      if (!current.company_id && companyId) {
        updates.company_id = companyId;
        changes.push({
          field: "company_id",
          label: "ลูกค้า",
          before: "(ว่าง)",
          after: String(companyId),
        });
      }
      if (!current.customer_alias_id && customerAliasId) {
        updates.customer_alias_id = customerAliasId;
      }
      if (!current.machine_id && machineId) {
        updates.machine_id = machineId;
        changes.push({
          field: "machine_id",
          label: "เครื่อง",
          before: "(ว่าง)",
          after: String(machineId),
        });
      }
      if (!current.flute_id && fluteId) {
        updates.flute_id = fluteId;
        changes.push({
          field: "flute_id",
          label: "ลอน",
          before: "(ว่าง)",
          after: String(fluteId),
        });
      }

      setIfEmpty("sale_order_no", toText(erpRow.sale_order_no), "Sale Order");
      setIfEmpty(
        "order_qty",
        toNumber(erpRow.order_qty ?? erpRow.demand_qty),
        "Order Qty",
      );
      setIfEmpty("size", sizeFromErp, "Size");
      setIfEmpty("shift", toText(erpRow.shift), "กะ");
      setIfEmpty("vehicle_plate", toText(erpRow.vehicle_plate), "ทะเบียนรถ");
      setIfEmpty(
        "customer_ship_date",
        toDate(erpRow.customer_ship_date || erpRow.delivery_date),
        "วันที่ส่งลูกค้า",
      );
      setIfEmpty(
        "production_date",
        toDate(erpRow.production_date),
        "วันที่ผลิต",
      );
      setIfEmpty(
        "weight_per_sheet",
        toNumber(erpRow.weight_per_sheet),
        "น้ำหนัก/แผ่น",
      );
      setIfEmpty(
        "price_per_sheet",
        toNumber(erpRow.price_per_sheet),
        "ราคา/แผ่น",
      );

      const tag = pickRejectTagFields(erpRow);
      setIfEmpty("cut_qty", tag.cutQty, "ผ่า");
      setIfEmpty("item_code", tag.itemCode, "รหัสสินค้า");
      setIfEmpty("big_sheet_qty", tag.bigSheetQty, "จำนวนแผ่นใหญ่");
      setIfEmpty("big_sheet_size", tag.bigSheetSize, "ขนาดแผ่นใหญ่");
      setIfEmpty("small_sheet_size", tag.smallSheetSize, "ขนาดแผ่นเล็ก");

      if (!Object.keys(updates).length) {
        return { record: current, changed: false, from_erp: true };
      }

      updates.updated_by = actor?.id || null;
      await rejects.updateById(id, updates);

      if (activityLogs) {
        await activityLogs.create({
          userId: actor?.id || null,
          username: actor?.username || null,
          displayName: actor?.display_name || null,
          department: actor?.department || null,
          action: "update",
          entityType: "reject_record",
          entityId: id,
          summary: `เติมข้อมูล Reject จาก ERP ${pdrNo} (${changes.length} ช่อง)`,
          changes,
        });
      }

      const record = await rejects.findById(id);
      return { record, changed: true, from_erp: true, changes };
    },
  };
}
