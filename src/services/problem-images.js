import { mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { resolve } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import { httpError } from "../core/http-error.js";
import { problemImageUrl } from "../utils/problem-image.js";

export const PROBLEM_IMAGE_UPLOAD_DIR = resolve(
  fileURLToPath(new URL("../../storage/uploads/problems/", import.meta.url)),
);
mkdirSync(PROBLEM_IMAGE_UPLOAD_DIR, { recursive: true });

const MAX_EDGE = 800;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function createProblemImageService(pool) {
  return {
    uploadDir: PROBLEM_IMAGE_UPLOAD_DIR,

    async findProblem(problemId) {
      const id = Number(problemId);
      if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Invalid id");
      const [rows] = await pool.query(
        `SELECT id, name, image_file FROM problems WHERE id = ? LIMIT 1`,
        [id],
      );
      const row = rows[0] || null;
      if (!row) throw httpError(404, "Not found");
      return row;
    },

    async getStoredPath(problemId) {
      const row = await this.findProblem(problemId);
      if (!row.image_file) return null;
      return resolve(PROBLEM_IMAGE_UPLOAD_DIR, row.image_file);
    },

    validateUpload(file) {
      if (!file) throw httpError(400, "กรุณาเลือกรูปภาพ");
      if (!ALLOWED_MIME.has(String(file.mimetype || ""))) {
        throw httpError(400, "รองรับเฉพาะไฟล์รูป JPEG, PNG, WebP, GIF");
      }
    },

    async processAndStore(file) {
      const stored = `${randomUUID()}.webp`;
      const outPath = resolve(PROBLEM_IMAGE_UPLOAD_DIR, stored);
      await sharp(file.path)
        .rotate()
        .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85 })
        .toFile(outPath);
      await unlink(file.path).catch(() => {});
      return stored;
    },

    async saveImage(problemId, file) {
      this.validateUpload(file);
      const row = await this.findProblem(problemId);
      const stored = await this.processAndStore(file);
      await pool.query(`UPDATE problems SET image_file = ? WHERE id = ?`, [
        stored,
        row.id,
      ]);
      if (row.image_file && row.image_file !== stored) {
        await unlink(resolve(PROBLEM_IMAGE_UPLOAD_DIR, row.image_file)).catch(() => {});
      }
      return {
        id: row.id,
        image_file: stored,
        image_url: problemImageUrl(row.id),
      };
    },

    async deleteImage(problemId) {
      const row = await this.findProblem(problemId);
      if (!row.image_file) return false;
      await pool.query(`UPDATE problems SET image_file = NULL WHERE id = ?`, [row.id]);
      await unlink(resolve(PROBLEM_IMAGE_UPLOAD_DIR, row.image_file)).catch(() => {});
      return true;
    },
  };
}
