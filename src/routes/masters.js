import { mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { resolve } from "path";
import multer from "multer";
import { createMasterService } from "../services/masters.js";
import {
  createProblemImageService,
  PROBLEM_IMAGE_UPLOAD_DIR,
} from "../services/problem-images.js";
import {
  canAccessMasters,
  canManageMasters,
  canManageProblemImages,
} from "../core/authz.js";

/**
 * Master APIs — filtering / search / pagination happen on backend.
 * Frontend only sends query params and renders the response.
 */
export function registerMasterRoutes(app, { pool, wrap, requireAuth }) {
  const masters = createMasterService(pool);
  const problemImages = createProblemImageService(pool);
  const keys = [
    "companies",
    "customer-aliases",
    "departments",
    "machines",
    "problems",
    "shifts",
  ];

  mkdirSync(PROBLEM_IMAGE_UPLOAD_DIR, { recursive: true });
  const problemImageUpload = multer({
    storage: multer.diskStorage({
      destination: PROBLEM_IMAGE_UPLOAD_DIR,
      filename: (_req, file, cb) => {
        const ext = String(file.originalname || "")
          .split(".")
          .pop()
          ?.toLowerCase();
        const safeExt = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)
          ? `.${ext === "jpeg" ? "jpg" : ext}`
          : ".bin";
        cb(null, `tmp-${Date.now()}${safeExt}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  for (const key of keys) {
    app.get(
      `/api/masters/${key}`,
      requireAuth,
      wrap(async (req, res) => {
        if (!canAccessMasters(req.user)) {
          return res.status(403).json({ message: "ไม่มีสิทธิ์ดู Master" });
        }
        const result = await masters.list(key, req.query);
        res.json(result);
      }),
    );

    app.post(
      `/api/masters/${key}`,
      requireAuth,
      wrap(async (req, res) => {
        if (!canManageMasters(req.user)) {
          return res.status(403).json({ message: "ไม่มีสิทธิ์จัดการ Master" });
        }
        const row = await masters.create(key, req.body || {});
        res.status(201).json({ data: row });
      }),
    );

    app.patch(
      `/api/masters/${key}/:id`,
      requireAuth,
      wrap(async (req, res) => {
        if (!canManageMasters(req.user)) {
          return res.status(403).json({ message: "ไม่มีสิทธิ์จัดการ Master" });
        }
        const row = await masters.update(key, req.params.id, req.body || {});
        res.json({ data: row });
      }),
    );
  }

  app.post(
    "/api/masters/problems/:id/image",
    requireAuth,
    problemImageUpload.single("file"),
    wrap(async (req, res) => {
      if (!canManageProblemImages(req.user)) {
        if (req.file?.path) await unlink(req.file.path).catch(() => {});
        return res.status(403).json({ message: "ไม่มีสิทธิ์อัปโหลดรูปปัญหา" });
      }
      try {
        const data = await problemImages.saveImage(req.params.id, req.file);
        res.json({ data });
      } catch (error) {
        if (req.file?.path) await unlink(req.file.path).catch(() => {});
        throw error;
      }
    }),
  );

  app.get(
    "/api/masters/problems/:id/image",
    requireAuth,
    wrap(async (req, res) => {
      const filePath = await problemImages.getStoredPath(req.params.id);
      if (!filePath) {
        return res.status(404).json({ message: "ไม่มีรูป" });
      }
      res.type("image/webp");
      res.sendFile(filePath);
    }),
  );

  app.delete(
    "/api/masters/problems/:id/image",
    requireAuth,
    wrap(async (req, res) => {
      if (!canManageProblemImages(req.user)) {
        return res.status(403).json({ message: "ไม่มีสิทธิ์ลบรูปปัญหา" });
      }
      const deleted = await problemImages.deleteImage(req.params.id);
      if (!deleted) {
        return res.status(404).json({ message: "ไม่มีรูป" });
      }
      res.json({ ok: true });
    }),
  );
}
