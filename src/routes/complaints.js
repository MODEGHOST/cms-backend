import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { createActivityLogRepository } from "../repositories/activity-logs.js";
import { createComplaintRepository } from "../repositories/complaints.js";
import { createRejectRepository } from "../repositories/rejects.js";
import { createUserRepository } from "../repositories/users.js";
import { createComplaintService } from "../services/complaints.js";
import { createRejectService } from "../services/rejects.js";
import {
  buildComplaintInboxFilter,
  COMPLAINT_WORKFLOW_LABELS,
} from "../services/complaint-inbox.js";
import {
  buildActionPlanPdf,
  canExportActionPlan,
} from "../services/action-plan-pdf.js";
import {
  collectPlanSignatureIds,
  normalizePlanForm,
  PLAN_APPROVAL_ROLES,
  PLAN_CONTRIBUTOR_MAX,
} from "../services/plan-form.js";
import { listPlanSigners, getPlanSignerSignaturePath } from "../services/plan-signers.js";
import { paginatedJson, parsePagination } from "../validators/common.js";
import { mergeRelatedRejects, parseProblemNames } from "../utils/problem-names.js";
import { createTelegramNotifier } from "../services/telegram-notifier.js";
import { config as appConfig } from "../core/config.js";
import { logger } from "../core/logger.js";
import { createFromErpService } from "../services/from-erp.js";
import { canCsWork } from "../core/authz.js";

const uploadsDirectory = resolve(
  fileURLToPath(new URL("../../storage/uploads/complaints/", import.meta.url)),
);
mkdirSync(uploadsDirectory, { recursive: true });

const FORM_OPTIONS_TTL_MS = 5 * 60 * 1000;
let formOptionsCache = null;
let formOptionsCachedAt = 0;

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDirectory,
    filename: (_req, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: {
    files: 10,
    fileSize: 15 * 1024 * 1024,
  },
});

export function registerComplaintRoutes(app, { pool, wrap, requireAuth, telegram }) {
  const complaints = createComplaintRepository(pool);
  const users = createUserRepository(pool);
  const activityLogs = createActivityLogRepository(pool);
  const service = createComplaintService(complaints, activityLogs);
  const rejects = createRejectRepository(pool);
  const fromErp = createFromErpService({
    config: appConfig,
    complaints,
    rejects,
    activityLogs,
  });
  const rejectService = createRejectService(
    pool,
    rejects,
    activityLogs,
  );

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

  async function withAttachments(record) {
    if (!record) return record;
    const relatedRows = await rejects.findRelatedForComplaint(record);
    const related = mergeRelatedRejects(relatedRows);
    return {
      ...record,
      attachments: await complaints.listAttachments(record.id),
      related_reject: related
        ? {
            id: related.id,
            pdr_no: related.pdr_no,
            problems: related.problems || [],
            problem_names: related.problem_names || [],
            problem_name: related.problem_name || null,
          }
        : null,
    };
  }

  function parseAttachmentIds(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0);
    } catch {
      const error = new Error("รายการไฟล์ที่ต้องการลบไม่ถูกต้อง");
      error.status = 400;
      throw error;
    }
  }

  async function resolveActor(req) {
    // requireAuth already hydrated roles/permissions — avoid a second DB round-trip.
    if (req.user?.id || req.user?.sub) {
      return {
        id: req.user.id || req.user.sub,
        username: req.user.username,
        display_name: req.user.display_name,
        role: req.user.role,
        roles: req.user.roles || [],
        permissions: req.user.permissions || [],
        department: req.user.department,
      };
    }
    const dbUser = await users.findById(req.user?.sub);
    if (!dbUser) {
      const error = new Error("ไม่พบบัญชีผู้ใช้");
      error.status = 401;
      throw error;
    }
    return {
      id: dbUser.id,
      username: dbUser.username,
      display_name: dbUser.display_name,
      role: dbUser.role,
      roles: dbUser.roles || [],
      permissions: dbUser.permissions || [],
      department: dbUser.department,
    };
  }

  app.get(
    "/api/complaints/inbox/count",
    requireAuth,
    wrap(async (req, res) => {
      const actor = await resolveActor(req);
      const filter = buildComplaintInboxFilter(actor);
      const total = filter.empty
        ? 0
        : await complaints.countInbox({
            whereSql: filter.whereSql,
            params: filter.params,
          });
      res.json({ total });
    }),
  );

  app.get(
    "/api/complaints/inbox",
    requireAuth,
    wrap(async (req, res) => {
      const actor = await resolveActor(req);
      const filter = buildComplaintInboxFilter(actor);
      const { page, pageSize, offset } = parsePagination({
        ...req.query,
        pageSize: Math.min(50, Number(req.query.pageSize) || 5),
      });
      const q = String(req.query.q || "").trim();

      if (filter.empty) {
        res.json(paginatedJson([], 0, { page, pageSize }));
        return;
      }

      const { rows, total } = await complaints.listInbox({
        whereSql: filter.whereSql,
        params: filter.params,
        q,
        limit: pageSize,
        offset,
      });

      res.json(
        paginatedJson(
          rows.map((row) => ({
            ...row,
            workflow_label:
              COMPLAINT_WORKFLOW_LABELS[row.workflow_status] || row.workflow_status,
          })),
          total,
          { page, pageSize },
        ),
      );
    }),
  );

  app.get(
    "/api/complaints",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.query.pdr_no || "").trim();
      if (!pdrNo) {
        const error = new Error("กรุณาระบุเลข PDR");
        error.status = 400;
        throw error;
      }
      const rows = await complaints.findByPdr(pdrNo);
      const data = await Promise.all(rows.map(withAttachments));
      res.json({ data, total: data.length, pdr_no: pdrNo });
    }),
  );

  /**
   * INSERT Complaint จากข้อมูลในฟอร์ม (หลัง Search แล้ว) — ไม่เรียก ERP ซ้ำ
   */
  app.post(
    "/api/complaints/from-draft",
    requireAuth,
    wrap(async (req, res) => {
      const actor = await resolveActor(req);
      if (!canCsWork(actor)) {
        const error = new Error("ไม่มีสิทธิ์สร้าง Complaint (ต้องมี complaints.cs)");
        error.status = 403;
        throw error;
      }
      const result = await fromErp.createComplaintFromDraft(req.body || {}, actor);
      const data = await Promise.all((result.data || []).map(withAttachments));
      res.status(result.created ? 201 : 200).json({
        ...result,
        data,
        total: data.length,
      });
    }),
  );

  /**
   * INSERT Complaint โดย GET ERP ใหม่ (fallback) — ไม่เขียนกลับ ERP
   */
  app.post(
    "/api/complaints/from-erp",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.body?.pdr_no || req.query.pdr_no || "").trim();
      const actor = await resolveActor(req);
      if (pdrNo) {
        const existing = await complaints.findByPdr(pdrNo);
        if (existing.length) {
          const data = await Promise.all(existing.map(withAttachments));
          res.json({
            data,
            total: data.length,
            pdr_no: pdrNo,
            created: false,
            from_erp: false,
          });
          return;
        }
      }
      if (!canCsWork(actor)) {
        const error = new Error("ไม่มีสิทธิ์สร้าง Complaint (ต้องมี complaints.cs)");
        error.status = 403;
        throw error;
      }
      const result = await fromErp.findOrCreateComplaint(pdrNo, actor);
      const data = await Promise.all((result.data || []).map(withAttachments));
      res.status(result.created ? 201 : 200).json({
        ...result,
        data,
        total: data.length,
      });
    }),
  );

  app.post(
    "/api/complaints/:id/cs-submit",
    requireAuth,
    upload.array("files", 10),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const files = req.files || [];
      try {
        if (!Number.isInteger(id) || id <= 0) {
          const error = new Error("รหัสรายการไม่ถูกต้อง");
          error.status = 400;
          throw error;
        }
        const dbUser = await resolveActor(req);
        const rawAction = String(req.body?.action || "").trim();
        const action = rawAction === "save" ? "save" : "submit";
        const actor = {
          id: dbUser.id,
          username: dbUser.username,
          display_name: dbUser.display_name,
          role: dbUser.role,
          roles: dbUser.roles || [],
          permissions: dbUser.permissions || [],
          department: dbUser.department,
        };
        const result = await service.updateCurrentStep(
          id,
          {
            problem_name: req.body?.problem_name,
            problem_names: parseProblemNames(req.body),
            ng_qty: req.body?.ng_qty,
            cs_remark: req.body?.cs_remark,
            received_date: req.body?.received_date,
            document_accepted: req.body?.document_accepted,
            action,
          },
          actor,
        );
        if (files.length) {
          await complaints.createAttachments(id, files, dbUser.id, "file");
        }
        const removed = await complaints.deleteAttachments(
          id,
          parseAttachmentIds(req.body?.remove_attachment_ids),
        );
        await Promise.all(
          removed.map((attachment) =>
            unlink(resolve(uploadsDirectory, attachment.stored_name)).catch(() => {}),
          ),
        );
        const updatedRecord = await complaints.findById(id);

        let rejectInfo = null;
        let rejectRecord = null;
        const repairFlag = String(req.body?.repair_flag || "").trim().toLowerCase();
        if (action === "submit" && repairFlag === "repair") {
          try {
            // ส่งคิวให้ QC เท่านั้น — ไม่ GET ERP ตอนแปลง (QC ค่อยดึงตอนเปิดฟอร์ม)
            const rejectResult = await rejectService.createStubFromComplaint(
              updatedRecord,
              actor,
            );
            rejectRecord = rejectResult.record || null;
            rejectInfo = {
              id: rejectRecord?.id || null,
              pdr_no: rejectRecord?.pdr_no || updatedRecord.pdr_no || null,
              created: Boolean(rejectResult.created),
            };
          } catch (convertError) {
            logger.warn("reject_from_complaint_failed", {
              complaintId: updatedRecord.id,
              pdr_no: updatedRecord.pdr_no,
              error: convertError?.message || String(convertError),
            });
            rejectInfo = {
              id: null,
              pdr_no: updatedRecord.pdr_no || null,
              created: false,
              error:
                convertError?.message ||
                "สร้างรายการ Reject ไม่สำเร็จ (Complaint บันทึกแล้ว)",
            };
          }
        }

        res.json({
          data: await withAttachments(updatedRecord),
          changed: result.changed || files.length > 0 || removed.length > 0,
          action: result.action,
          reject: rejectInfo,
        });

        if (notifier && result.action === "submit" && updatedRecord.workflow_status !== "cs_draft") {
          notifyTelegram(
            notifier.onStatusChange(updatedRecord, updatedRecord.workflow_status, actor),
            "complaint_status_change",
            { complaintId: updatedRecord.id, status: updatedRecord.workflow_status },
          );
        }
        if (notifier && rejectInfo?.created && rejectRecord) {
          notifyTelegram(
            notifier.onRejectCreated(rejectRecord, actor),
            "reject_created",
            { rejectId: rejectRecord.id },
          );
        }
      } catch (error) {
        await Promise.all(
          files.map((file) => unlink(file.path).catch(() => {})),
        );
        throw error;
      }
    }),
  );

  app.post(
    "/api/complaints/:id/qa-submit",
    requireAuth,
    upload.array("files", 10),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const files = req.files || [];
      try {
        if (!Number.isInteger(id) || id <= 0) {
          const error = new Error("รหัสรายการไม่ถูกต้อง");
          error.status = 400;
          throw error;
        }
        const actor = await resolveActor(req);
        const current = await complaints.findById(id);
        if (!current) {
          const error = new Error("ไม่พบรายการ Complaint");
          error.status = 404;
          throw error;
        }
        const prevStatus = current.workflow_status;
        const rawAction = String(req.body?.action || "").trim();
        const action = rawAction === "save" ? "save" : "submit";
        const result = await service.updateCurrentStep(
          id,
          {
            problem_name: req.body?.problem_name,
            problem_names: parseProblemNames(req.body),
            ng_qty: req.body?.ng_qty,
            cs_remark: req.body?.cs_remark,
            reported_by_department_name: req.body?.reported_by_department_name,
            responsible_department_name: req.body?.responsible_department_name,
            document_accepted: req.body?.document_accepted,
            document_scope: req.body?.document_scope,
            document_no: req.body?.document_no,
            action,
          },
          actor,
        );
        if (files.length) {
          await complaints.createAttachments(id, files, actor.id, "file");
        }
        const removed = await complaints.deleteAttachments(
          id,
          parseAttachmentIds(req.body?.remove_attachment_ids),
        );
        await Promise.all(
          removed.map((attachment) =>
            unlink(resolve(uploadsDirectory, attachment.stored_name)).catch(() => {}),
          ),
        );
        const updatedRecord = await complaints.findById(id);

        let rejectInfo = null;
        let rejectRecord = null;
        const repairFlag = String(req.body?.repair_flag || "").trim().toLowerCase();
        if (repairFlag === "repair") {
          try {
            const rejectResult = await rejectService.createStubFromComplaint(
              updatedRecord,
              actor,
            );
            rejectRecord = rejectResult.record || null;
            rejectInfo = {
              id: rejectRecord?.id || null,
              pdr_no: rejectRecord?.pdr_no || updatedRecord.pdr_no || null,
              created: Boolean(rejectResult.created),
            };
          } catch (convertError) {
            logger.warn("reject_from_complaint_failed", {
              complaintId: updatedRecord.id,
              pdr_no: updatedRecord.pdr_no,
              error: convertError?.message || String(convertError),
            });
            rejectInfo = {
              id: null,
              pdr_no: updatedRecord.pdr_no || null,
              created: false,
              error:
                convertError?.message ||
                "สร้างรายการ Reject ไม่สำเร็จ (Complaint บันทึกแล้ว)",
            };
          }
        }

        res.json({
          data: await withAttachments(updatedRecord),
          changed: result.changed || files.length > 0 || removed.length > 0,
          action: result.action,
          reject: rejectInfo,
        });

        if (notifier && updatedRecord.workflow_status !== prevStatus) {
          notifyTelegram(
            notifier.onStatusChange(
              updatedRecord,
              updatedRecord.workflow_status,
              actor,
            ),
            "complaint_status_change",
            { complaintId: updatedRecord.id, status: updatedRecord.workflow_status },
          );
        }
        if (notifier && rejectInfo?.created && rejectRecord) {
          notifyTelegram(
            notifier.onRejectCreated(rejectRecord, actor),
            "reject_created",
            { rejectId: rejectRecord.id },
          );
        }
      } catch (error) {
        await Promise.all(
          files.map((file) => unlink(file.path).catch(() => {})),
        );
        throw error;
      }
    }),
  );

  const planUploadFields = [
    { name: "files", maxCount: 10 },
    { name: "signatures", maxCount: 5 },
    ...Array.from({ length: PLAN_CONTRIBUTOR_MAX }, (_, index) => ({
      name: `plan_sig_contributor_${index}`,
      maxCount: 1,
    })),
    ...PLAN_APPROVAL_ROLES.map((role) => ({
      name: role.field,
      maxCount: 1,
    })),
  ];

  app.post(
    "/api/complaints/:id/department-submit",
    requireAuth,
    upload.fields(planUploadFields),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const files = req.files?.files || [];
      const signatures = req.files?.signatures || [];
      const planUploads = [];
      for (let index = 0; index < PLAN_CONTRIBUTOR_MAX; index += 1) {
        const list = req.files?.[`plan_sig_contributor_${index}`] || [];
        if (list[0]) planUploads.push({ key: `contributor_${index}`, file: list[0] });
      }
      for (const role of PLAN_APPROVAL_ROLES) {
        const list = req.files?.[role.field] || [];
        if (list[0]) planUploads.push({ key: role.key, file: list[0] });
      }
      const uploaded = [
        ...files,
        ...signatures,
        ...planUploads.map((item) => item.file),
      ];
      try {
        if (!Number.isInteger(id) || id <= 0) {
          const error = new Error("รหัสรายการไม่ถูกต้อง");
          error.status = 400;
          throw error;
        }
        const dbUser = await resolveActor(req);
        const current = await complaints.findById(id);
        if (!current) {
          const error = new Error("ไม่พบรายการ Complaint");
          error.status = 404;
          throw error;
        }

        const prevStatus = current.workflow_status;
        const actor = {
          id: dbUser.id,
          username: dbUser.username,
          display_name: dbUser.display_name,
          role: dbUser.role,
          roles: dbUser.roles || [],
          permissions: dbUser.permissions || [],
          department: dbUser.department,
        };
        const result = await service.updateCurrentStep(
          id,
          {
            cause: req.body?.cause,
            correction: req.body?.correction,
            prevention: req.body?.prevention,
            completed_date: req.body?.completed_date,
            remark: req.body?.remark,
            action:
              current.workflow_status === "qa_confirm"
                ? "dept_update"
                : req.body?.action === "save"
                  ? "save"
                  : "submit",
          },
          actor,
        );
        let createdFileIds = [];
        if (files.length) {
          createdFileIds = await complaints.createAttachments(
            id,
            files,
            dbUser.id,
            "file",
          );
        }
        if (signatures.length) {
          await complaints.createAttachments(id, signatures, dbUser.id, "signature");
        }

        const previousPlan = normalizePlanForm(current.plan_form_json);
        let nextPlan = req.body?.plan_form
          ? normalizePlanForm(req.body.plan_form)
          : previousPlan;

        let pdfImageSlots = nextPlan.pdfImageSlots || {};
        if (req.body?.pdf_image_slots) {
          try {
            const parsed =
              typeof req.body.pdf_image_slots === "string"
                ? JSON.parse(req.body.pdf_image_slots)
                : req.body.pdf_image_slots;
            if (parsed && typeof parsed === "object") {
              pdfImageSlots = { ...pdfImageSlots, ...parsed };
            }
          } catch {
            const error = new Error("ตำแหน่งรูปใน PDF ไม่ถูกต้อง");
            error.status = 400;
            throw error;
          }
        }

        let newFileSlots = [];
        if (req.body?.new_file_slots) {
          try {
            newFileSlots =
              typeof req.body.new_file_slots === "string"
                ? JSON.parse(req.body.new_file_slots)
                : req.body.new_file_slots;
            if (!Array.isArray(newFileSlots)) newFileSlots = [];
          } catch {
            newFileSlots = [];
          }
        }
        createdFileIds.forEach((attachmentId, index) => {
          const slot = String(newFileSlots[index] || "picture").trim() || "picture";
          pdfImageSlots[String(attachmentId)] = slot;
        });

        nextPlan = {
          ...nextPlan,
          pdfImageSlots,
        };
        // ถ้ารูปแบบที่ส่งมาไม่มี pdfImageSlots ให้คงค่าเดิมไว้
        if (
          req.body?.plan_form &&
          Object.keys(nextPlan.pdfImageSlots || {}).length === 0 &&
          Object.keys(previousPlan.pdfImageSlots || {}).length > 0
        ) {
          nextPlan = {
            ...nextPlan,
            pdfImageSlots: previousPlan.pdfImageSlots,
          };
        }

        for (const item of planUploads) {
          const [newId] = await complaints.createAttachments(
            id,
            [item.file],
            dbUser.id,
            "signature",
          );
          if (item.key.startsWith("contributor_")) {
            const index = Number(item.key.replace("contributor_", ""));
            if (nextPlan.contributors[index]) {
              nextPlan.contributors[index].signatureId = newId;
            }
          } else if (nextPlan.approvals[item.key]) {
            nextPlan.approvals[item.key].signatureId = newId;
          }
        }

        const previousIds = collectPlanSignatureIds(previousPlan);
        const nextIds = new Set(collectPlanSignatureIds(nextPlan));
        const orphanPlanIds = previousIds.filter((attachmentId) => !nextIds.has(attachmentId));

        const removed = await complaints.deleteAttachments(id, [
          ...parseAttachmentIds(req.body?.remove_attachment_ids),
          ...orphanPlanIds,
        ]);
        await Promise.all(
          removed.map((attachment) =>
            unlink(resolve(uploadsDirectory, attachment.stored_name)).catch(() => {}),
          ),
        );

        const planChanged =
          JSON.stringify(previousPlan) !== JSON.stringify(nextPlan) || planUploads.length > 0;
        if (planChanged) {
          await complaints.updatePlanFormJson(id, nextPlan);
        }

        const updatedRecord = await complaints.findById(id);
        res.json({
          data: await withAttachments(updatedRecord),
          changed:
            result.changed ||
            files.length > 0 ||
            signatures.length > 0 ||
            removed.length > 0 ||
            planChanged,
          action: result.action,
        });

        if (
          notifier &&
          updatedRecord?.workflow_status &&
          updatedRecord.workflow_status !== prevStatus
        ) {
          notifyTelegram(
            notifier.onStatusChange(updatedRecord, updatedRecord.workflow_status, actor),
            "complaint_status_change",
            { complaintId: updatedRecord.id, status: updatedRecord.workflow_status },
          );
        }
      } catch (error) {
        await Promise.all(
          uploaded.map((file) => unlink(file.path).catch(() => {})),
        );
        throw error;
      }
    }),
  );

  app.post(
    "/api/complaints/:id/qa-confirm-save",
    requireAuth,
    upload.array("files", 10),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      const files = req.files || [];
      try {
        if (!Number.isInteger(id) || id <= 0) {
          const error = new Error("รหัสรายการไม่ถูกต้อง");
          error.status = 400;
          throw error;
        }
        const dbUser = await resolveActor(req);

        let pdfImageSlots = {};
        if (req.body?.pdf_image_slots) {
          try {
            pdfImageSlots =
              typeof req.body.pdf_image_slots === "string"
                ? JSON.parse(req.body.pdf_image_slots)
                : req.body.pdf_image_slots;
          } catch {
            const error = new Error("ตำแหน่งรูปใน PDF ไม่ถูกต้อง");
            error.status = 400;
            throw error;
          }
        }

        let newFileSlots = [];
        if (req.body?.new_file_slots) {
          try {
            newFileSlots =
              typeof req.body.new_file_slots === "string"
                ? JSON.parse(req.body.new_file_slots)
                : req.body.new_file_slots;
            if (!Array.isArray(newFileSlots)) newFileSlots = [];
          } catch {
            newFileSlots = [];
          }
        }

        const result = await service.updateCurrentStep(
          id,
          {
            action: "save",
            cause: req.body?.cause,
            correction: req.body?.correction,
            prevention: req.body?.prevention,
            remark: req.body?.remark,
            pdf_image_slots: pdfImageSlots,
          },
          {
            id: dbUser.id,
            username: dbUser.username,
            display_name: dbUser.display_name,
            role: dbUser.role,
            roles: dbUser.roles || [],
            permissions: dbUser.permissions || [],
            department: dbUser.department,
          },
        );

        let createdIds = [];
        if (files.length) {
          createdIds = await complaints.createAttachments(id, files, dbUser.id, "file");
        }

        const removed = await complaints.deleteAttachments(
          id,
          parseAttachmentIds(req.body?.remove_attachment_ids),
        );
        await Promise.all(
          removed.map((attachment) =>
            unlink(resolve(uploadsDirectory, attachment.stored_name)).catch(() => {}),
          ),
        );

        // map slot สำหรับไฟล์ใหม่ตามลำดับอัปโหลด
        if (createdIds.length) {
          const current = await complaints.findById(id);
          const previousPlan = normalizePlanForm(current.plan_form_json);
          const nextSlots = { ...(previousPlan.pdfImageSlots || {}) };
          createdIds.forEach((attachmentId, index) => {
            const slot = String(newFileSlots[index] || "picture").trim() || "picture";
            nextSlots[String(attachmentId)] = slot;
          });
          const nextPlan = normalizePlanForm({
            ...previousPlan,
            pdfImageSlots: nextSlots,
          });
          await complaints.updatePlanFormJson(id, nextPlan);
        }

        res.json({
          data: await withAttachments(await complaints.findById(id)),
          changed:
            result.changed || files.length > 0 || removed.length > 0 || createdIds.length > 0,
          action: result.action,
        });
      } catch (error) {
        await Promise.all(files.map((file) => unlink(file.path).catch(() => {})));
        throw error;
      }
    }),
  );

  app.get(
    "/api/complaint-attachments/:id/download",
    requireAuth,
    wrap(async (req, res) => {
      const attachment = await complaints.findAttachmentById(Number(req.params.id));
      if (!attachment) {
        const error = new Error("ไม่พบไฟล์แนบ");
        error.status = 404;
        throw error;
      }
      const filePath = resolve(uploadsDirectory, attachment.stored_name);
      if (
        req.query.inline === "1" &&
        String(attachment.mime_type || "").startsWith("image/")
      ) {
        res.type(attachment.mime_type);
        res.sendFile(filePath);
        return;
      }
      res.download(
        filePath,
        attachment.original_name,
      );
    }),
  );

  app.get(
    "/api/complaints/form-options",
    requireAuth,
    wrap(async (_req, res) => {
      const now = Date.now();
      if (formOptionsCache && now - formOptionsCachedAt < FORM_OPTIONS_TTL_MS) {
        res.json(formOptionsCache);
        return;
      }
      const [departments] = await pool.query(
        `SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name`,
      );
      const [problems] = await pool.query(
        `SELECT id, name, name_en FROM problems WHERE is_active = 1 ORDER BY name`,
      );
      const [machines] = await pool.query(
        `SELECT id, name FROM machines WHERE is_active = 1 ORDER BY name`,
      );
      const [flutes] = await pool.query(
        `SELECT id, name FROM flutes WHERE is_active = 1 ORDER BY name`,
      );
      formOptionsCache = {
        departments,
        problems,
        machines,
        flutes,
        plan_signers: listPlanSigners(),
      };
      formOptionsCachedAt = now;
      res.json(formOptionsCache);
    }),
  );

  app.get(
    "/api/plan-signers",
    requireAuth,
    wrap(async (_req, res) => {
      res.json({ data: listPlanSigners() });
    }),
  );

  app.get(
    "/api/plan-signers/:id/signature",
    requireAuth,
    wrap(async (req, res) => {
      const file = getPlanSignerSignaturePath(req.params.id);
      if (!file) {
        const error = new Error("ไม่พบลายเซ็น");
        error.status = 404;
        throw error;
      }
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.sendFile(file.filePath);
    }),
  );

  app.get(
    "/api/complaints/next-document-no",
    requireAuth,
    wrap(async (_req, res) => {
      const documentNo = await complaints.getNextApDocumentNo();
      res.json({ data: { document_no: documentNo } });
    }),
  );

  app.get(
    "/api/complaints/:id/action-plan.pdf",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }
      const record = await complaints.findById(id);
      if (!record) {
        const error = new Error("ไม่พบรายการ Complaint");
        error.status = 404;
        throw error;
      }
      if (!canExportActionPlan(record)) {
        const error = new Error(
          "ดาวน์โหลด Action Plan ได้เฉพาะรายการที่รับเอกสาร (P) และปิดงานแล้ว",
        );
        error.status = 400;
        throw error;
      }
      const attachments = await complaints.listAttachments(id, {
        includeStoredName: true,
      });
      const pdf = await buildActionPlanPdf(record, {
        attachments,
        uploadsDirectory,
      });
      res.setHeader("Content-Type", pdf.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(pdf.filename)}`,
      );
      res.send(pdf.buffer);
    }),
  );

  app.patch(
    "/api/complaints/:id",
    requireAuth,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        const error = new Error("รหัสรายการไม่ถูกต้อง");
        error.status = 400;
        throw error;
      }
      const dbUser = await resolveActor(req);
      const prevStatus = (await complaints.findById(id))?.workflow_status;
      const actor = {
        id: dbUser.id,
        username: dbUser.username,
        display_name: dbUser.display_name,
        role: dbUser.role,
        roles: dbUser.roles || [],
        permissions: dbUser.permissions || [],
        department: dbUser.department,
      };
      const result = await service.updateCurrentStep(id, req.body || {}, actor);
      res.json({
        data: await withAttachments(result.record),
        changed: result.changed,
        action: result.action,
      });

      // Notify on any workflow transition (submit / accept / confirm), not only action=submit.
      if (notifier && result.record?.workflow_status && result.record.workflow_status !== prevStatus) {
        notifyTelegram(
          notifier.onStatusChange(result.record, result.record.workflow_status, actor),
          "complaint_status_change",
          { complaintId: result.record.id, status: result.record.workflow_status },
        );
      }
    }),
  );
}
