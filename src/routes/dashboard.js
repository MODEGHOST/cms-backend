import { createDashboardService } from "../services/dashboard.js";

/**
 * Dashboard routes — filtering is done entirely on the backend.
 */
export function registerDashboardRoutes(app, { pool, wrap, requireAuth }) {
  const dashboard = createDashboardService(pool);

  app.get(
    "/api/dashboard/reject",
    requireAuth,
    wrap(async (req, res) => {
      const data = await dashboard.getRejectSummary(req.query);
      res.json(data);
    }),
  );

  app.get(
    "/api/dashboard/reject/day-detail",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getRejectDayDetail(req.query);
        res.json(data);
      } catch (err) {
        if (err.status === 400) {
          res.status(400).json({ message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/dashboard/reject/kpi-detail",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getKpiDetail(req.query);
        res.json(data);
      } catch (err) {
        if (err.status === 400) {
          res.status(400).json({ message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/dashboard/reject/problem-detail",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getProblemDetail(req.query);
        res.json(data);
      } catch (err) {
        if (err.status === 400 || err.status === 404) {
          res.status(err.status).json({ message: err.message });
          return;
        }
        throw err;
      }
    }),
  );

  app.get(
    "/api/dashboard/reject/department-detail",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getDepartmentDetail(req.query);
        res.json(data);
      } catch (err) {
        if (err.status === 400 || err.status === 404) {
          res.status(err.status).json({ message: err.message });
          return;
        }
        throw err;
      }
    }),
  );
}
