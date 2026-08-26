import { config } from "../core/config.js";

export function registerHealthRoutes(app) {
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "cms-backend",
      module: "reject",
      jwtFp: config.jwtSecretFp,
      time: new Date().toISOString(),
    });
  });
}
