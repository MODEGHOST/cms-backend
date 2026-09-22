import mysql from "mysql2/promise";
import { config } from "../core/config.js";
import { logger } from "../core/logger.js";

let cachedRows = null;
let cachedAt = 0;
let inflight = null;

function normalizeCompanyName(name) {
  let text = String(name || "").toLowerCase();
  text = text.replace(/บริษัท|จำกัด|ห้างหุ้นส่วนจำกัด|หจก\.?|บจก\.?/gu, "");
  text = text.replace(/[.\s\-_/,\\()（）'"′″`]/gu, "");
  return text.trim();
}

function similarity(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left || !right) return 0;
  if (left === right) return 1;

  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  if (longer.includes(shorter) && shorter.length >= 4) {
    return shorter.length / longer.length;
  }
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = new Map();
  for (let i = 0; i < left.length - 1; i += 1) {
    const gram = left.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }

  let match = 0;
  for (let i = 0; i < right.length - 1; i += 1) {
    const gram = right.slice(i, i + 2);
    const count = bigrams.get(gram) || 0;
    if (count > 0) {
      bigrams.set(gram, count - 1);
      match += 1;
    }
  }

  return (2 * match) / (left.length - 1 + (right.length - 1));
}

function pickBestMatch(companyName, rows, minScore = 0.82) {
  const target = normalizeCompanyName(companyName);
  if (!target) return null;

  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    const cand = normalizeCompanyName(row.customer_name);
    if (!cand) continue;
    const score = cand === target ? 1 : similarity(target, cand);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best || bestScore < minScore) return null;
  return { row: best, score: bestScore };
}

function isConfigured(cc = config.customerCare) {
  return Boolean(cc?.enabled && cc.host && cc.database && cc.user);
}

async function loadRows(cc = config.customerCare) {
  const now = Date.now();
  if (cachedRows && now - cachedAt < cc.cacheTtlMs) {
    return cachedRows;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const connection = await mysql.createConnection({
      host: cc.host,
      port: cc.port,
      user: cc.user,
      password: cc.password,
      database: cc.database,
      dateStrings: true,
      charset: "utf8mb4",
    });
    try {
      const table = cc.table || "customer_care";
      const [rows] = await connection.query(
        `SELECT customer_name, grade, sale_nickname, cs_name FROM \`${table}\``,
      );
      cachedRows = rows || [];
      cachedAt = Date.now();
      return cachedRows;
    } finally {
      await connection.end().catch(() => {});
      inflight = null;
    }
  })();

  return inflight;
}

function toCareResult(row, score = null) {
  if (!row) return null;
  const saleNickname = String(row.sale_nickname || "").trim() || null;
  const csName = String(row.cs_name || "").trim() || null;
  const grade = String(row.grade || "").trim() || null;
  const parts = [saleNickname, csName].filter(Boolean);
  return {
    customer_name: row.customer_name || null,
    sale_nickname: saleNickname,
    cs_name: csName,
    grade,
    sale_cs_staff: parts.length ? parts.join(" / ") : null,
    match_score: score,
  };
}

/**
 * Lookup Sale/CS/grade for a company name from leefibre.customer_care.
 * Returns null when disabled, unconfigured, or no match.
 */
export async function lookupCustomerCare(companyName) {
  const cc = config.customerCare;
  if (!isConfigured(cc)) return null;
  const name = String(companyName || "").trim();
  if (!name) return null;

  try {
    const rows = await loadRows(cc);
    const match = pickBestMatch(name, rows, cc.minScore);
    if (!match) return null;
    return toCareResult(match.row, match.score);
  } catch (error) {
    logger.warn("customer_care_lookup_failed", {
      company: name,
      error: error?.message || String(error),
    });
    return null;
  }
}

export function customerCareStatus() {
  const cc = config.customerCare;
  return {
    enabled: Boolean(cc.enabled),
    configured: isConfigured(cc),
    host: cc.host || null,
    database: cc.database || null,
    table: cc.table || null,
  };
}
