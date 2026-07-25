export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  const production = nodeEnv === "production";
  const jwtSecret = env.JWT_SECRET || (production ? "" : "development-secret");

  if (production && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters in production");
  }

  return Object.freeze({
    nodeEnv,
    production,
    port: Number(env.PORT || 4000),
    frontendUrl: env.FRONTEND_URL || "http://localhost:5173",
    jwtSecret,
    authTokenTtl: env.AUTH_TOKEN_TTL || "8h",
    trustProxy: env.TRUST_PROXY === "1",
    seedDemoData: env.SEED_DEMO_DATA == null ? !production : env.SEED_DEMO_DATA === "1",
    cookie: Object.freeze({
      sameSite: env.COOKIE_SAME_SITE || "lax",
      secure: env.COOKIE_SECURE === "1",
      domain: env.COOKIE_DOMAIN || undefined,
    }),
    db: Object.freeze({
      host: env.DB_HOST || "localhost",
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USER || "root",
      password: env.DB_PASSWORD || "",
      database: env.DB_NAME || "cms",
      connectionLimit: Number(env.DB_POOL_LIMIT || 20),
    }),
  });
}

export const config = loadConfig();
