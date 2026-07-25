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
