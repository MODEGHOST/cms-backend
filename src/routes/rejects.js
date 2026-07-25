/**
 * Reject record routes — CRUD + import
 */
export function registerRejectRoutes(app, { wrap, requireAuth }) {
  app.get(
    "/api/rejects",
    requireAuth,
    wrap(async (_req, res) => {
      res.status(501).json({ message: "List rejects not implemented yet" });
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
