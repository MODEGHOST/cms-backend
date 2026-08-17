import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function applyEnvFile(path, { override = false } = {}) {
  const existingPort = process.env.PORT;
  dotenv.config({ path, override });
  if (override && existingPort) {
    process.env.PORT = existingPort;
  }
}

export function loadEnv(rootDir = packageRoot) {
  const localPath = resolve(rootDir, ".env");
  const productionPath = resolve(rootDir, ".env.production");
  const forceProduction =
    process.env.USE_PRODUCTION_ENV === "1" || process.env.NODE_ENV === "production";

  if (forceProduction && existsSync(productionPath)) {
    applyEnvFile(productionPath, { override: true });
    return;
  }

  if (existsSync(localPath)) {
    applyEnvFile(localPath, { override: false });
    return;
  }

  if (existsSync(productionPath)) {
    applyEnvFile(productionPath, { override: true });
  }
}

loadEnv();
