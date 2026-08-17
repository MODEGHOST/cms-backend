/**
 * Replace problems master with the canonical list.
 * - Upsert new names as active
 * - Keep existing name_en when the Thai/English name already matches
 * - Soft-deactivate old names not in the list
 * - Hard-delete deactivated rows that are not referenced by reject/complaint records
 * Safe to re-run.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";
import { PROBLEM_NAMES } from "./data/problems-master-list.js";

function uniqueNames(names) {
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase("th");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

async function main() {
  const names = uniqueNames(PROBLEM_NAMES);
  if (!names.length) {
    throw new Error("Problem list is empty");
  }

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  try {
    await conn.beginTransaction();

    const [existingRows] = await conn.query(
      "SELECT id, name, name_en, is_active FROM problems",
    );

    const byNameCi = new Map();
    for (const row of existingRows) {
      byNameCi.set(String(row.name).toLocaleLowerCase("th"), row);
    }

    // Hide everything first; only canonical rows stay active after upsert.
    await conn.query("UPDATE problems SET is_active = 0");

    let inserted = 0;
    let updated = 0;
    let keptEn = 0;
    const keepIds = [];

    for (const name of names) {
      const existing = byNameCi.get(name.toLocaleLowerCase("th"));
      const nameEn = existing?.name_en ? String(existing.name_en).trim() : null;
      if (nameEn) keptEn += 1;

      if (existing) {
        await conn.query(
          `UPDATE problems
           SET name = ?, name_en = ?, is_active = 1
           WHERE id = ?`,
          [name, nameEn || null, existing.id],
        );
        keepIds.push(existing.id);
        updated += 1;
      } else {
        const [result] = await conn.query(
          `INSERT INTO problems (name, name_en, is_active) VALUES (?, NULL, 1)`,
          [name],
        );
        keepIds.push(result.insertId);
        inserted += 1;
      }
    }

    const [deleteResult] = await conn.query(
      `DELETE p FROM problems p
       WHERE p.is_active = 0
         AND NOT EXISTS (
           SELECT 1 FROM reject_records rr WHERE rr.problem_id = p.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM complaint_records cr WHERE cr.problem_id = p.id
         )`,
    );

    await conn.commit();

    const [[{ active }]] = await conn.query(
      "SELECT COUNT(*) AS active FROM problems WHERE is_active = 1",
    );
    const [[{ total }]] = await conn.query(
      "SELECT COUNT(*) AS total FROM problems",
    );
    const [[{ inactiveKept }]] = await conn.query(
      "SELECT COUNT(*) AS inactiveKept FROM problems WHERE is_active = 0",
    );
    const [withEn] = await conn.query(
      `SELECT name, name_en FROM problems
       WHERE is_active = 1 AND name_en IS NOT NULL AND TRIM(name_en) <> ''
       ORDER BY name ASC`,
    );

    console.log(
      JSON.stringify(
        {
          canonicalCount: names.length,
          inserted,
          updatedExisting: updated,
          matchedWithNameEn: keptEn,
          hardDeleted: deleteResult.affectedRows || 0,
          inactiveKeptForFk: inactiveKept,
          activeNow: active,
          totalNow: total,
          keepIdsCount: keepIds.length,
          preservedEnglishCount: withEn.length,
          preservedEnglishSamples: withEn.slice(0, 25),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
