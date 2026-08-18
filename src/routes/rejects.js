import { createRejectRepository } from "../repositories/rejects.js";
import { createActivityLogRepository } from "../repositories/activity-logs.js";
import { createRejectService } from "../services/rejects.js";
import { createTelegramNotifier } from "../services/telegram-notifier.js";
import { canUpdateRejects } from "../core/authz.js";
import { config as appConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { paginatedJson, parsePagination, toDateOnly } from "../validators/common.js";
import { createFromErpService } from "../services/from-erp.js";
import { createComplaintRepository } from "../repositories/complaints.js";
import { createUserRepository } from "../repositories/users.js";
import { buildRejectMemoPdf } from "../services/reject-memo-pdf.js";
import { buildRejectTagPdf } from "../services/reject-tag-pdf.js";
import {
  normalizeMemoTagOverrides,
  parsePalletLines,
} from "../services/reject-pdf-shared.js";

const FORM_OPTIONS_TTL_MS = 5 * 60 * 1000;
let formOptionsCache = null;
let formOptionsCachedAt = 0;

/** Reject record routes — list / lookup + QC update. */
export function registerRejectRoutes(app, { pool, wrap, requireAuth, telegram }) {
  const rejects = createRejectRepository(pool);
  const users = createUserRepository(pool);
  const activityLogs = createActivityLogRepository(pool);
  const rejectService = createRejectService(pool, rejects, activityLogs);
  const fromErp = createFromErpService({
    config: appConfig,
    complaints: createComplaintRepository(pool),
    rejects,
    activityLogs,
  });
  const notifier = telegram
    ? createTelegramNotifier({ telegram, users, config: appConfig, logger })
    : null;

  function notifyTelegram(promise, event, meta = {}) {
    promise.catch((err) => {
      logger.warn("telegram_notify_failed", {
        event,
        error: err?.message || String(err),
        ...meta,
      });
    });
  }

  app.get(
    "/api/rejects",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.query.pdr_no || "").trim();
      if (pdrNo) {
        const rows = await rejects.findByPdr(pdrNo);
        res.json({
          data: rows,
          total: rows.length,
          pdr_no: pdrNo,
        });
        return;
      }

      const { page, pageSize, offset } = parsePagination(req.query);
      const source = String(req.query.source || "").trim() || null;
      const q = String(req.query.q || "").trim();
      const { rows, total } = await rejects.list({
        source,
        q,
        limit: pageSize,
        offset,
      });
      res.json(paginatedJson(rows, total, { page, pageSize }));
    }),
  );

  app.get(
    "/api/rejects/form-options",
    requireAuth,
    wrap(async (_req, res) => {
      const now = Date.now();
      if (formOptionsCache && now - formOptionsCachedAt < FORM_OPTIONS_TTL_MS) {
        res.json(formOptionsCache);
        return;
      }
      const [departments] = await pool.query(
        `SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC`,
      );
      const [problems] = await pool.query(
        `SELECT id, name FROM problems WHERE is_active = 1 ORDER BY name ASC`,
      );
      const [jobTypeRows] = await pool.query(
        `SELECT DISTINCT job_type AS name
         FROM reject_records
         WHERE job_type IS NOT NULL AND TRIM(job_type) <> ''
         ORDER BY job_type ASC`,
      );
      const job_types = (jobTypeRows.length
        ? jobTypeRows
        : [{ name: "แผ่น" }, { name: "กล่อง" }]
      ).map((row) => ({ name: row.name }));

      formOptionsCache = { departments, problems, job_types };
      formOptionsCachedAt = now;
      res.json(formOptionsCache);
    }),
  );

  /**
   * INSERT Reject จากข้อมูลในฟอร์ม (หลัง Search แล้ว) — ไม่เรียก ERP ซ้ำ
   */
  app.post(
    "/api/rejects/from-draft",
    requireAuth,
    wrap(async (req, res) => {
      const actor = req.user;
      if (!canUpdateRejects(actor)) {
        const error = new Error("ไม่มีสิทธิ์แก้ไข Reject (ต้องมี rejects.update)");
        error.status = 403;
        throw error;
      }
      const result = await fromErp.createRejectFromDraft(req.body || {}, {
        id: actor.id || req.user.sub,
        username: actor.username,
        display_name: actor.display_name,
        department: actor.department || null,
      });
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  /**
   * INSERT Reject โดย GET ERP ใหม่ (fallback) — ไม่เขียนกลับ ERP
   */
  app.post(
    "/api/rejects/from-erp",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.body?.pdr_no || req.query.pdr_no || "").trim();
      const actor = req.user;
      if (pdrNo) {
        const existing = await rejects.findByPdr(pdrNo);
        if (existing.length) {
          res.json({
            data: existing,
            total: existing.length,
            pdr_no: pdrNo,
            created: false,
            from_erp: false,
          });
          return;
        }
      }
      if (!canUpdateRejects(actor)) {
        const error = new Error("ไม่มีสิทธิ์สร้าง Reject (ต้องมี rejects.update)");
        error.status = 403;
        throw error;
      }
      const result = await fromErp.findOrCreateReject(pdrNo, {
        id: actor.id || req.user.sub,
        username: actor.username,
        display_name: actor.display_name,
        department: actor.department || null,
      });
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  /**
   * เติมช่อง ERP ที่ว่างบน Reject ที่มีอยู่ (เช่น stub จาก Complaint)
   * GET ERP อย่างเดียว — ไม่เขียนกลับ ERP
   */
  app.post(
    "/api/rejects/:id/enrich-from-erp",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }
      const actor = req.user;
      if (!canUpdateRejects(actor)) {
        const error = new Error("ไม่มีสิทธิ์แก้ไข Reject (ต้องมี rejects.update)");
        error.status = 403;
        throw error;
      }
      const result = await fromErp.enrichRejectFromErp(id, {
        id: actor.id || req.user.sub,
        username: actor.username,
        display_name: actor.display_name,
        department: actor.department || null,
      });
      res.json({
        data: result.record,
        changed: result.changed,
        from_erp: true,
      });
    }),
  );

  app.get(
    "/api/rejects/:id",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }
      const row = await rejects.findById(id);
      if (!row) {
        const error = new Error("ไม่พบรายการ Reject");
        error.status = 404;
        throw error;
      }
      res.json({ data: row });
    }),
  );

  app.patch(
    "/api/rejects/:id",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }

      const actor = req.user;
      if (!canUpdateRejects(actor)) {
        const error = new Error("ไม่มีสิทธิ์แก้ไข Reject (ต้องมี rejects.update)");
        error.status = 403;
        throw error;
      }

      const result = await rejectService.updateQcFields(id, req.body || {}, {
        id: actor.id || req.user.sub,
        username: actor.username,
        display_name: actor.display_name,
        department: actor.department || null,
        role: actor.role,
        roles: actor.roles || [],
        permissions: actor.permissions || [],
      });

      if (notifier && result.changed && result.record) {
        notifyTelegram(
          notifier.onRejectUpdated(result.record, {
            id: actor.id || req.user.sub,
            username: actor.username,
            display_name: actor.display_name,
          }),
          "reject_updated",
          { rejectId: result.record.id, action: result.action },
        );
      }

      res.json({
        data: result.record,
        changed: result.changed,
        action: result.action || null,
      });
    }),
  );

  app.post(
    "/api/rejects/:id/return-to-cs",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }

      const actor = req.user;
      if (!canUpdateRejects(actor)) {
        const error = new Error("ไม่มีสิทธิ์ตีกลับ Reject (ต้องมี rejects.update)");
        error.status = 403;
        throw error;
      }

      const actorInfo = {
        id: actor.id || req.user.sub,
        username: actor.username,
        display_name: actor.display_name,
        department: actor.department || null,
      };
      const result = await rejectService.returnToCs(
        id,
        req.body?.reason,
        actorInfo,
      );

      if (notifier && result.record) {
        notifyTelegram(
          notifier.onRejectReturnedToCs(result.record, result.reason, actorInfo),
          "reject_returned_to_cs",
          { rejectId: result.record.id },
        );
      }

      res.json({
        data: {
          id: result.record.id,
          pdr_no: result.record.pdr_no,
          source_complaint_id: result.record.source_complaint_id,
        },
        returned: true,
        reason: result.reason,
      });
    }),
  );

  async function loadRejectOrThrow(idParam) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      const error = new Error("รหัสรายการไม่ถูกต้อง");
      error.status = 400;
      throw error;
    }
    const row = await rejects.findById(id);
    if (!row) {
      const error = new Error("ไม่พบรายการ Reject");
      error.status = 404;
      throw error;
    }
    return row;
  }

  async function applyPdfOverrides(record, body = {}) {
    // Overrides are download-only — never persist to reject_records.
    return {
      ...record,
      memo_lot_no: body.lot_no ?? body.memo_lot_no ?? record.memo_lot_no,
      pallet_count: body.pallet_count ?? record.pallet_count,
      pallet_lines: parsePalletLines(body.pallet_lines ?? record.pallet_lines),
      repair_with_qty: body.repair_with_qty ?? record.repair_with_qty,
      memo_customer_return_qty:
        body.customer_return_qty ??
        body.memo_customer_return_qty ??
        record.memo_customer_return_qty,
      tag_ship_date: body.tag_ship_date ?? record.tag_ship_date,
    };
  }

  app.post(
    "/api/rejects/:id/memo.pdf",
    requireAuth,
    wrap(async (req, res) => {
      const record = await loadRejectOrThrow(req.params.id);
      const merged = await applyPdfOverrides(record, req.body || {});
      const overrides = normalizeMemoTagOverrides(req.body || {}, merged);
      const pdf = await buildRejectMemoPdf(merged, overrides);
      res.setHeader("Content-Type", pdf.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(pdf.filename)}`,
      );
      res.send(pdf.buffer);
    }),
  );

  app.post(
    "/api/rejects/:id/tag.pdf",
    requireAuth,
    wrap(async (req, res) => {
      const record = await loadRejectOrThrow(req.params.id);
      const merged = await applyPdfOverrides(record, req.body || {});
      const overrides = normalizeMemoTagOverrides(req.body || {}, merged);
      const pdf = await buildRejectTagPdf(merged, overrides);
      res.setHeader("Content-Type", pdf.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(pdf.filename)}`,
      );
      res.send(pdf.buffer);
    }),
  );

  app.post(
    "/api/rejects",
    requireAuth,
    wrap(async (_req, res) => {
      res.status(501).json({ message: "Create reject not implemented yet" });
    }),
  );
}
