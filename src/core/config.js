import { createHash } from "node:crypto";

const PLACEHOLDER_JWT = new Set([
  "lfb-center-change-this-in-production",
  "development-secret",
  "change-this-to-at-least-32-characters",
]);

function jwtSecretFingerprint(secret) {
  return createHash("sha256").update(String(secret || "")).digest("hex").slice(0, 12);
}

function normalizeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "";
  if (/\s|\\|\/\/|[?]/.test(raw)) {
    throw new Error("BASE_PATH must be a simple URL path such as /lfb_cms/backend");
  }
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, "");
}

/** Browser Origin is scheme+host+port — strip path from FRONTEND_URL. */
export function originFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

function collectCorsOrigins(env) {
  const origins = new Set();
  const add = (value) => {
    const origin = originFromUrl(value);
    if (origin) origins.add(origin);
  };
  add(env.FRONTEND_URL || "http://localhost:5174");
  add("http://localhost:5173");
  add("http://127.0.0.1:5173");
  add("http://localhost:5174");
  add("http://127.0.0.1:5174");
  add("http://localhost:5180");
  add("http://127.0.0.1:5180");
  for (const part of String(env.CORS_ORIGINS || "").split(",")) {
    add(part);
  }
  return Object.freeze([...origins]);
}

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
  if (production && PLACEHOLDER_JWT.has(jwtSecret)) {
    throw new Error("JWT_SECRET must be a unique production value shared by Portal, IPMS, and CMS");
  }

  const smtpUser = env.SMTP_USER || "";
  const smtpPass = env.SMTP_PASS || "";
  const smtpConfigured = Boolean(smtpUser && smtpPass);
  if (production && !smtpConfigured && env.ALLOW_MISSING_SMTP !== "1") {
    throw new Error("SMTP_USER and SMTP_PASS are required in production");
  }

  const smtpSecure =
    env.SMTP_SECURE == null
      ? Number(env.SMTP_PORT || 587) === 465
      : env.SMTP_SECURE === "1";

  return Object.freeze({
    nodeEnv,
    production,
    port: Number(env.PORT || 4000),
    /** IIS virtual path (e.g. /lfb_cms/backend). Empty = routes at /api/... */
    basePath: normalizeBasePath(env.BASE_PATH),
    frontendUrl: env.FRONTEND_URL || "http://localhost:5174",
    corsOrigins: collectCorsOrigins(env),
    jwtSecret,
    jwtSecretFp: jwtSecretFingerprint(jwtSecret),
    authTokenTtl: env.AUTH_TOKEN_TTL || "8h",
    trustProxy: env.TRUST_PROXY === "1" ? 1 : false,
    seedDemoData: env.SEED_DEMO_DATA == null ? !production : env.SEED_DEMO_DATA === "1",
    emailFrom:
      env.EMAIL_FROM ||
      (smtpUser ? `CMS <${smtpUser}>` : "CMS <noreply@localhost>"),
    smtp: Object.freeze({
      host: env.SMTP_HOST || "smtp.gmail.com",
      port: Number(env.SMTP_PORT || 587),
      secure: smtpSecure,
      user: smtpUser,
      pass: smtpPass,
      configured: smtpConfigured,
    }),
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
      connectionLimit: Number(env.DB_POOL_LIMIT || 40),
      queueLimit: Number(env.DB_POOL_QUEUE_LIMIT || 200),
    }),
    /** Seconds to reuse hydrated CMS user (roles/permissions) per id. 0 = off. */
    authUserCacheTtlSec: Math.max(0, Number(env.AUTH_USER_CACHE_TTL_SEC ?? 20)),
    /** Cap concurrent SQL waves inside one dashboard summary request. */
    dashboardSqlBatchSize: Math.max(2, Number(env.DASHBOARD_SQL_BATCH_SIZE || 4)),
    /** Day-detail item list hard cap (aggregates still use full counts). */
    dashboardDayDetailLimit: Math.max(50, Number(env.DASHBOARD_DAY_DETAIL_LIMIT || 500)),
    telegram: Object.freeze({
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      enabled: env.TELEGRAM_ENABLED === "1",
      // When set, all notifications go here (dev/group mode) instead of per-user lookup.
      groupChatId: String(env.TELEGRAM_GROUP_CHAT_ID || "").trim() || null,
      // Optional static invite. If empty, the bot creates one from the group.
      groupInviteLink: String(env.TELEGRAM_GROUP_INVITE_LINK || "").trim() || null,
    }),
    telegramAuth: Object.freeze({
      botToken: env.TELEGRAM_AUTH_BOT_TOKEN || "",
      username: String(env.TELEGRAM_AUTH_BOT_USERNAME || "")
        .trim()
        .replace(/^@/, ""),
      enabled: env.TELEGRAM_AUTH_BOT_ENABLED === "1",
    }),
    // Central SSO identity: shared_auth.Center_user_lfb (no app roles here).
    sharedDbName: env.SHARED_DB_NAME || "shared_auth",
    centerUserTable: env.CENTER_USER_TABLE || "Center_user_lfb",
    // ERP PDR API (Beta_api_erp) — off by default; never list-all, only ?pdr_no=
    erp: Object.freeze({
      enabled: env.ERP_API_ENABLED === "1",
      baseUrl: String(env.ERP_API_URL || "").trim().replace(/\/$/, ""),
      timeoutMs: Math.max(1000, Number(env.ERP_API_TIMEOUT_MS || 5000)),
    }),
  });
}

export const config = loadConfig();

/** Prefix public API paths when IIS does not strip the app path. */
export function publicApiPath(path) {
  const prefix = config.basePath || "";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${prefix}${normalized}`;
}
