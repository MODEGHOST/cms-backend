import { createRejectRepository } from "../repositories/rejects.js";
import { createActivityLogRepository } from "../repositories/activity-logs.js";
import { createUserRepository } from "../repositories/users.js";
import { createRejectService } from "../services/rejects.js";
import { canUpdateRejects } from "../core/authz.js";

/** Reject record routes — lookup + QC update. */
export function registerRejectRoutes(app, { pool, wrap, requireAuth }) {
  const rejects = createRejectRepository(pool);
  const activityLogs = createActivityLogRepository(pool);
  const users = createUserRepository(pool);
  const rejectService = createRejectService(pool, rejects, activityLogs);

  app.get(
    "/api/rejects",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.query.pdr_no || "").trim();
      if (!pdrNo) {
        const error = new Error("กรุณาระบุเลข PDR");
        error.status = 400;
        throw error;
      }

      const rows = await rejects.findByPdr(pdrNo);
      res.json({
        data: rows,
        total: rows.length,
        pdr_no: pdrNo,
      });
    }),
  );

  app.get(
    "/api/rejects/form-options",
    requireAuth,
    wrap(async (_req, res) => {
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

      res.json({ departments, problems, job_types });
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

      const dbUser = await users.findById(req.user.sub);
      const actor = dbUser || req.user;
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

      res.json({
        data: result.record,
        changed: result.changed,
        action: result.action || null,
      });
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
