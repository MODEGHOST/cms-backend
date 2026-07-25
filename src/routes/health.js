export function registerHealthRoutes(app) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "cms-backend",
      module: "reject",
      time: new Date().toISOString(),
    });
  });
}
