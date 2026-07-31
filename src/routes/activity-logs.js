import { createActivityLogRepository } from "../repositories/activity-logs.js";

export function registerActivityLogRoutes(app, { pool, wrap, requireAuth }) {
  const logs = createActivityLogRepository(pool);

  app.get(
    "/api/activity-logs",
    requireAuth,
    wrap(async (req, res) => {
      const result = await logs.list(req.query);
      res.json(result);
    }),
  );
}
