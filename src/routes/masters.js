import { createMasterService } from "../services/masters.js";
import { canAccessMasters, canManageMasters } from "../core/authz.js";

/**
 * Master APIs — filtering / search / pagination happen on backend.
 * Frontend only sends query params and renders the response.
 */
export function registerMasterRoutes(app, { pool, wrap, requireAuth }) {
  const masters = createMasterService(pool);
  const keys = [
    "companies",
    "customer-aliases",
    "departments",
    "machines",
    "problems",
    "shifts",
  ];

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
}
