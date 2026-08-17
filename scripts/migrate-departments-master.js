/**
 * Sync departments master from List Department.xlsx + remap legacy names.
 *
 * Canonical (active): ENG, FG, HR, IQC, LAB, LTS, MA, MKT, PD, PKG, PLAN,
 *   PU, QA, QC, RM, SALE, WH + รอเคลียร์
 *
 * Legacy map (case-insensitive for English):
 *   CRM, CS, Customer Service, ตลาด → MKT
 *   EN → ENG
 *   Packing → PKG
 *   plan / วางแผน → PLAN
 *   production / ผลิต_QC → PD
 *   LTS, MKT, PD, QA, QC, รอเคลียร์ → keep
 *
 * Safe to re-run. Use --dry-run to preview only.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import XLSX from "xlsx";
import { config } from "../src/core/config.js";
import {
  DEPARTMENT_LEGACY_MAP,
  normalizeDepartmentKey,
} from "../src/utils/department-map.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes("--dry-run");

const KEEP_EXTRA = ["รอเคลียร์"];

/** @deprecated use DEPARTMENT_LEGACY_MAP — kept for script clarity */
const LEGACY_MAP = DEPARTMENT_LEGACY_MAP;

function normalizeKey(value) {
  return normalizeDepartmentKey(value);
}

function loadCanonicalFromExcel() {
  const candidates = [
    process.env.DEPARTMENT_LIST_XLSX,
    path.join("c:/Users/sa.data02/Downloads/List Department.xlsx"),
    path.join(__dirname, "../data/List Department.xlsx"),
  ].filter(Boolean);

  for (const filePath of candidates) {
    try {
      const wb = XLSX.readFile(filePath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
      const names = [];
      for (const row of rows) {
        const raw = Array.isArray(row) ? row[0] : null;
        const name = String(raw || "").trim();
        if (!name || /^department$/i.test(name)) continue;
        names.push(name);
      }
      if (names.length) {
        console.log(`Loaded ${names.length} departments from ${filePath}`);
        return names;
      }
    } catch {
      // try next path
    }
  }

  console.warn("Excel not found — using built-in canonical list");
  return [
    "ENG",
    "FG",
    "HR",
    "IQC",
    "LAB",
    "LTS",
    "MA",
    "MKT",
    "PD",
    "PKG",
    "PLAN",
    "PU",
    "QA",
    "QC",
    "RM",
    "SALE",
    "WH",
  ];
}

async function ensureDepartment(conn, name) {
  // Case-insensitive match first (utf8mb4_unicode_ci) — normalize casing
  const [ciRows] = await conn.query(
    `SELECT id, name, is_active FROM departments WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [name],
  );
  if (ciRows[0]) {
    const needsRename = ciRows[0].name !== name;
    const needsActivate = !ciRows[0].is_active;
    if ((needsRename || needsActivate) && !dryRun) {
      await conn.query(
        `UPDATE departments SET name = ?, is_active = 1 WHERE id = ?`,
        [name, ciRows[0].id],
      );
    }
    if (needsRename) {
      console.log(
        `  rename ${JSON.stringify(ciRows[0].name)} → ${JSON.stringify(name)} (id=${ciRows[0].id})`,
      );
    } else if (needsActivate) {
      console.log(`  reactivate ${JSON.stringify(name)} (id=${ciRows[0].id})`);
    }
    return ciRows[0].id;
  }

  if (!dryRun) {
    const [result] = await conn.query(
      `INSERT INTO departments (name, is_active) VALUES (?, 1)`,
      [name],
    );
    console.log(`  insert ${JSON.stringify(name)} (id=${result.insertId})`);
    return result.insertId;
  }
  console.log(`  [dry-run] would insert ${JSON.stringify(name)}`);
  return null;
}

async function remapFk(conn, table, column, fromId, toId) {
  if (fromId === toId) return 0;
  if (dryRun) {
    const [[{ c }]] = await conn.query(
      `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`,
      [fromId],
    );
    return Number(c);
  }
  const [result] = await conn.query(
    `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
    [toId, fromId],
  );
  return result.affectedRows;
}

async function main() {
  const fromExcel = loadCanonicalFromExcel();
  const canonical = [...new Set([...fromExcel, ...KEEP_EXTRA])];
  const canonicalKeys = new Set(canonical.map(normalizeKey));

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    if (!dryRun) await conn.beginTransaction();

    console.log(`\n=== Ensure ${canonical.length} canonical departments ===`);
    const idByKey = new Map();
    for (const name of canonical) {
      const id = await ensureDepartment(conn, name);
      if (id != null) idByKey.set(normalizeKey(name), id);
    }

    // Refresh map after inserts/renames
    const [allDeps] = await conn.query(
      `SELECT id, name, is_active FROM departments ORDER BY name`,
    );
    for (const d of allDeps) {
      idByKey.set(normalizeKey(d.name), d.id);
    }

    console.log(`\n=== Remap legacy departments → canonical ===`);
    const summary = {
      reject: 0,
      complaint_responsible: 0,
      complaint_reported: 0,
      users: 0,
      deactivated: [],
      unmapped: [],
    };

    for (const dep of allDeps) {
      const key = normalizeKey(dep.name);
      const targetName = LEGACY_MAP[key];

      if (!targetName) {
        if (!canonicalKeys.has(key)) {
          summary.unmapped.push(dep.name);
        }
        continue;
      }

      const targetId = idByKey.get(normalizeKey(targetName));
      if (!targetId) {
        if (dryRun) {
          console.log(
            `  [dry-run] ${JSON.stringify(dep.name)} (id=${dep.id}) → ${JSON.stringify(targetName)} (new)`,
          );
          const [[{ c1 }]] = await conn.query(
            `SELECT COUNT(*) AS c1 FROM reject_records WHERE department_id = ?`,
            [dep.id],
          );
          const [[{ c2 }]] = await conn.query(
            `SELECT COUNT(*) AS c2 FROM complaint_records WHERE responsible_department_id = ?`,
            [dep.id],
          );
          const [[{ c3 }]] = await conn.query(
            `SELECT COUNT(*) AS c3 FROM complaint_records WHERE reported_by_department_id = ?`,
            [dep.id],
          );
          summary.reject += Number(c1);
          summary.complaint_responsible += Number(c2);
          summary.complaint_reported += Number(c3);
          summary.deactivated.push(dep.name);
          continue;
        }
        throw new Error(`Missing target department ${targetName}`);
      }

      if (dep.id === targetId) {
        // Already canonical (maybe just casing fixed)
        continue;
      }

      console.log(
        `  ${JSON.stringify(dep.name)} (id=${dep.id}) → ${JSON.stringify(targetName)} (id=${targetId})`,
      );

      summary.reject += await remapFk(
        conn,
        "reject_records",
        "department_id",
        dep.id,
        targetId,
      );
      summary.complaint_responsible += await remapFk(
        conn,
        "complaint_records",
        "responsible_department_id",
        dep.id,
        targetId,
      );
      summary.complaint_reported += await remapFk(
        conn,
        "complaint_records",
        "reported_by_department_id",
        dep.id,
        targetId,
      );

      if (!dryRun) {
        // ลบแผนกเก่าถ้าไม่มี FK ค้าง — ไม่ให้โผล่ใน Master / dropdown
        const [[{ reject_c }]] = await conn.query(
          `SELECT COUNT(*) AS reject_c FROM reject_records WHERE department_id = ?`,
          [dep.id],
        );
        const [[{ resp_c }]] = await conn.query(
          `SELECT COUNT(*) AS resp_c FROM complaint_records WHERE responsible_department_id = ?`,
          [dep.id],
        );
        const [[{ report_c }]] = await conn.query(
          `SELECT COUNT(*) AS report_c FROM complaint_records WHERE reported_by_department_id = ?`,
          [dep.id],
        );
        const refs = Number(reject_c) + Number(resp_c) + Number(report_c);
        if (refs === 0) {
          await conn.query(`DELETE FROM departments WHERE id = ?`, [dep.id]);
          console.log(`  deleted legacy ${JSON.stringify(dep.name)}`);
        } else {
          await conn.query(
            `UPDATE departments SET is_active = 0 WHERE id = ?`,
            [dep.id],
          );
          console.log(
            `  deactivate ${JSON.stringify(dep.name)} (still referenced x${refs})`,
          );
        }
      }
      summary.deactivated.push(dep.name);
    }

    // Deactivate any leftover non-canonical active rows
    const [activeLeft] = await conn.query(
      `SELECT id, name FROM departments WHERE is_active = 1`,
    );
    for (const dep of activeLeft) {
      if (canonicalKeys.has(normalizeKey(dep.name))) continue;
      console.log(`  deactivate leftover ${JSON.stringify(dep.name)}`);
      if (!dryRun) {
        await conn.query(`UPDATE departments SET is_active = 0 WHERE id = ?`, [
          dep.id,
        ]);
      }
      if (!summary.deactivated.includes(dep.name)) {
        summary.deactivated.push(dep.name);
      }
    }

    console.log(`\n=== Remap users.department (string) ===`);
    const [users] = await conn.query(
      `SELECT id, username, department FROM users
       WHERE department IS NOT NULL AND TRIM(department) <> ''`,
    );
    for (const user of users) {
      const key = normalizeKey(user.department);
      const target = LEGACY_MAP[key];
      if (!target || target === user.department) continue;
      console.log(
        `  user ${user.username}: ${JSON.stringify(user.department)} → ${JSON.stringify(target)}`,
      );
      if (!dryRun) {
        await conn.query(`UPDATE users SET department = ? WHERE id = ?`, [
          target,
          user.id,
        ]);
      }
      summary.users += 1;
    }

    if (!dryRun) await conn.commit();

    const [finalDeps] = await conn.query(
      `SELECT id, name, is_active FROM departments ORDER BY is_active DESC, name ASC`,
    );

    console.log(`\n=== Done${dryRun ? " (dry-run)" : ""} ===`);
    console.log(
      JSON.stringify(
        {
          dryRun,
          fk_updates: {
            reject_records: summary.reject,
            complaint_responsible: summary.complaint_responsible,
            complaint_reported: summary.complaint_reported,
          },
          users_updated: summary.users,
          deactivated: summary.deactivated,
          unmapped_legacy: summary.unmapped,
          departments: finalDeps,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!dryRun) await conn.rollback();
    throw error;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
