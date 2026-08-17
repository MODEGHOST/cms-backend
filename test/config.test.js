import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/core/config.js";

test("loadConfig returns development defaults", () => {
  const cfg = loadConfig({
    NODE_ENV: "development",
    JWT_SECRET: "development-secret",
  });
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.db.database, "cms");
});

test("corsOrigins uses host only, not FRONTEND_URL path", () => {
  const cfg = loadConfig({
    NODE_ENV: "development",
    JWT_SECRET: "development-secret",
    FRONTEND_URL: "http://apps.company.local/lfb_cms/frontend",
    CORS_ORIGINS: "http://10.0.0.10",
  });
  assert.ok(cfg.corsOrigins.includes("http://apps.company.local"));
  assert.ok(cfg.corsOrigins.includes("http://10.0.0.10"));
  assert.ok(!cfg.corsOrigins.includes("http://apps.company.local/lfb_cms/frontend"));
});
