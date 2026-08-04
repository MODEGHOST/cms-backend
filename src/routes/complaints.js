import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { createActivityLogRepository } from "../repositories/activity-logs.js";
import { createComplaintRepository } from "../repositories/complaints.js";
import { createUserRepository } from "../repositories/users.js";
import { createComplaintService } from "../services/complaints.js";
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
import { paginatedJson, parsePagination } from "../validators/common.js";

const uploadsDirectory = resolve(
  fileURLToPath(new URL("../../storage/uploads/complaints/", import.meta.url)),
);
mkdirSync(uploadsDirectory, { recursive: true });

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

export function registerComplaintRoutes(app, { pool, wrap, requireAuth }) {
  const complaints = createComplaintRepository(pool);
  const users = createUserRepository(pool);
  const service = createComplaintService(
    complaints,
    createActivityLogRepository(pool),
  );

  async function withAttachments(record) {
    if (!record) return record;
    return {
      ...record,
      attachments: await complaints.listAttachments(record.id),
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
    const dbUser = await users.findById(req.user.sub);
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
        const dbUser = await users.findById(req.user.sub);
        if (!dbUser) {
          const error = new Error("ไม่พบบัญชีผู้ใช้");
          error.status = 401;
          throw error;
        }
        const result = await service.updateCurrentStep(
          id,
          {
            problem_name: req.body?.problem_name,
            ng_qty: req.body?.ng_qty,
            received_date: req.body?.received_date,
            document_accepted: req.body?.document_accepted,
            action: req.body?.action === "save" ? "save" : "submit",
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
        res.json({
          data: await withAttachments(await complaints.findById(id)),
          changed: result.changed || files.length > 0 || removed.length > 0,
          action: result.action,
        });
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
        const dbUser = await users.findById(req.user.sub);
        if (!dbUser) {
          const error = new Error("ไม่พบบัญชีผู้ใช้");
          error.status = 401;
          throw error;
        }
        const current = await complaints.findById(id);
        if (!current) {
          const error = new Error("ไม่พบรายการ Complaint");
          error.status = 404;
          throw error;
        }

        const result = await service.updateCurrentStep(
          id,
          {
            cause: req.body?.cause,
            correction: req.body?.correction,
            prevention: req.body?.prevention,
            completed_date: req.body?.completed_date,
            remark: req.body?.remark,
            action: req.body?.action === "save" ? "save" : "submit",
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
        if (files.length) {
          await complaints.createAttachments(id, files, dbUser.id, "file");
        }
        if (signatures.length) {
          await complaints.createAttachments(id, signatures, dbUser.id, "signature");
        }

        const previousPlan = normalizePlanForm(current.plan_form_json);
        let nextPlan = req.body?.plan_form
          ? normalizePlanForm(req.body.plan_form)
          : previousPlan;
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

        res.json({
          data: await withAttachments(await complaints.findById(id)),
          changed:
            result.changed ||
            files.length > 0 ||
            signatures.length > 0 ||
            removed.length > 0 ||
            planChanged,
          action: result.action,
        });
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
        const dbUser = await users.findById(req.user.sub);
        if (!dbUser) {
          const error = new Error("ไม่พบบัญชีผู้ใช้");
          error.status = 401;
          throw error;
        }

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
      res.json({ departments, problems, machines, flutes });
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
      const dbUser = await users.findById(req.user.sub);
      if (!dbUser) {
        const error = new Error("ไม่พบบัญชีผู้ใช้");
        error.status = 401;
        throw error;
      }
      const result = await service.updateCurrentStep(id, req.body || {}, {
        id: dbUser.id,
        username: dbUser.username,
        display_name: dbUser.display_name,
        role: dbUser.role,
        roles: dbUser.roles || [],
        permissions: dbUser.permissions || [],
        department: dbUser.department,
      });
      res.json({
        data: await withAttachments(result.record),
        changed: result.changed,
        action: result.action,
      });
    }),
  );
}
