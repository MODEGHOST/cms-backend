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
          await complaints.createAttachments(id, files, dbUser.id);
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

  app.post(
    "/api/complaints/:id/department-submit",
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
          await complaints.createAttachments(id, files, dbUser.id);
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
