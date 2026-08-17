import { createComplaintDashboardService } from "../services/complaint-dashboard.js";
import { createDashboardService } from "../services/dashboard.js";
import { createDeptTargetRateService } from "../services/dept-target-rate.js";
import { createOrderRateService } from "../services/order-rate.js";

/** Forward the service's own 400/404 instead of bubbling up as a 500. */
function handled(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req.query));
    } catch (err) {
      if (err.status === 400 || err.status === 404) {
        res.status(err.status).json({ message: err.message });
        return;
      }
      throw err;
    }
  };
}

/**
 * Dashboard routes — filtering is done entirely on the backend.
 */
export function registerDashboardRoutes(app, { pool, wrap, requireAuth }) {
  const dashboard = createDashboardService(pool);
  const complaintDashboard = createComplaintDashboardService(pool);
  const orderRate = createOrderRateService(pool);
  const deptTargetRate = createDeptTargetRateService(pool);

  app.get(
    "/api/dashboard/reject",
    requireAuth,
    wrap(async (req, res) => {
      const data = await dashboard.getRejectSummary(req.query);
      res.json(data);
    }),
  );

  app.get(
    "/api/dashboard/reject/trend",
    requireAuth,
    wrap(async (req, res) => {
      const data = await dashboard.getRejectTrend(req.query);
      res.json(data);
    }),
  );

  app.get(
    "/api/dashboard/reject/filter-options",
    requireAuth,
    wrap(async (req, res) => {
      const data = await dashboard.getRejectFilterOptions();
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
    "/api/dashboard/reject/summary-table",
    requireAuth,
    wrap(handled((query) => dashboard.getSummaryTable(query))),
  );

  app.get(
    "/api/dashboard/reject/top-comparison",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getTopComparison(req.query);
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
    "/api/dashboard/reject/machine-comparison",
    requireAuth,
    wrap(async (req, res) => {
      try {
        const data = await dashboard.getMachineComparison(req.query);
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

  app.get(
    "/api/dashboard/reject/order-rate",
    requireAuth,
    wrap(handled((query) => orderRate.getRejectOrderRate(query))),
  );

  app.get(
    "/api/dashboard/reject/dept-target-rate",
    requireAuth,
    wrap(handled((query) => deptTargetRate.getRejectDeptTargetRate(query))),
  );

  app.put(
    "/api/dashboard/reject/dept-target-rate/targets",
    requireAuth,
    wrap(async (req, res) => {
      try {
        res.json(await deptTargetRate.updateRejectTargets(req.body || {}));
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
    "/api/dashboard/complaint",
    requireAuth,
    wrap(handled((query) => complaintDashboard.getSummary(query))),
  );

  app.get(
    "/api/dashboard/complaint/trend",
    requireAuth,
    wrap(handled((query) => complaintDashboard.getTrend(query))),
  );

  app.get(
    "/api/dashboard/complaint/filter-options",
    requireAuth,
    wrap(handled(() => complaintDashboard.getFilterOptions())),
  );

  app.get(
    "/api/dashboard/complaint/summary-table",
    requireAuth,
    wrap(handled((query) => complaintDashboard.getSummaryTable(query))),
  );

  app.get(
    "/api/dashboard/complaint/kpi-detail",
    requireAuth,
    wrap(handled((query) => complaintDashboard.getKpiDetail(query))),
  );

  app.get(
    "/api/dashboard/complaint/entity-detail",
    requireAuth,
    wrap(handled((query) => complaintDashboard.getEntityDetail(query))),
  );

  app.get(
    "/api/dashboard/complaint/order-rate",
    requireAuth,
    wrap(handled((query) => orderRate.getComplaintOrderRate(query))),
  );

  app.get(
    "/api/dashboard/complaint/dept-target-rate",
    requireAuth,
    wrap(handled((query) => deptTargetRate.getComplaintDeptTargetRate(query))),
  );

  app.put(
    "/api/dashboard/complaint/dept-target-rate/targets",
    requireAuth,
    wrap(async (req, res) => {
      try {
        res.json(await deptTargetRate.updateComplaintTargets(req.body || {}));
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
