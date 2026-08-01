/**
 * Create shared_auth.Center_user_lfb and copy identity from lfbsmart_project.users.
 * Keeps the same ids so cms / PRD local user FKs stay aligned.
 *
 * Safe to re-run: upserts by id/username.
 */
import "../src/core/load-env.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

const SOURCE_DB = process.env.CENTER_SOURCE_DB || "lfbsmart_project";
const CENTER_DB = config.sharedDbName;
const CENTER_TABLE = config.centerUserTable;

function splitName(row) {
  const first = String(row.first_name || "").trim();
  const last = String(row.last_name || "").trim();
  if (first || last) {
    return { firstName: first || "User", lastName: last || "-" };
  }
  const parts = String(row.name || row.username || "User")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "-",
  };
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const schemaSql = await readFile(
    resolve(root, "database/shared_auth_Center_user_lfb.sql"),
    "utf8",
  );

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
  });

  try {
    await conn.query(schemaSql);

    // In case env overrides table/db names that differ from schema file defaults.
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${CENTER_DB}\``);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS \`${CENTER_DB}\`.\`${CENTER_TABLE}\` (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        username VARCHAR(80) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        email VARCHAR(190) NOT NULL,
        telegram_id VARCHAR(64) NULL,
        department VARCHAR(120) NULL,
        status ENUM('active', 'suspended', 'pending') NOT NULL DEFAULT 'active',
        token_version INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_center_user_username (username),
        UNIQUE KEY uq_center_user_email (email),
        UNIQUE KEY uq_center_user_telegram (telegram_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [sourceUsers] = await conn.query(
      `SELECT id, name, first_name, last_name, email, username, telegram_id,
              password_hash, department, status, token_version
       FROM \`${SOURCE_DB}\`.users
       ORDER BY id ASC`,
    );

    let inserted = 0;
    let updated = 0;
    for (const row of sourceUsers) {
      const { firstName, lastName } = splitName(row);
      const email = String(row.email || `${row.username}@cms.local`).trim().toLowerCase();
      const telegram =
        row.telegram_id && String(row.telegram_id).trim()
          ? String(row.telegram_id).trim()
          : null;
      const status = ["active", "suspended", "pending"].includes(row.status)
        ? row.status
        : "active";

      const [result] = await conn.query(
        `INSERT INTO \`${CENTER_DB}\`.\`${CENTER_TABLE}\`
           (id, first_name, last_name, username, password_hash, email, telegram_id,
            department, status, token_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           first_name = VALUES(first_name),
           last_name = VALUES(last_name),
           username = VALUES(username),
           password_hash = VALUES(password_hash),
           email = VALUES(email),
           telegram_id = VALUES(telegram_id),
           department = VALUES(department),
           status = VALUES(status),
           token_version = VALUES(token_version)`,
        [
          row.id,
          firstName,
          lastName,
          row.username,
          row.password_hash,
          email,
          telegram,
          row.department || null,
          status,
          Number(row.token_version || 0),
        ],
      );
      if (Number(result.affectedRows) === 1) inserted += 1;
      else if (Number(result.affectedRows) === 2) updated += 1;
    }

    const [[{ maxId }]] = await conn.query(
      `SELECT COALESCE(MAX(id), 0) AS maxId FROM \`${CENTER_DB}\`.\`${CENTER_TABLE}\``,
    );
    if (Number(maxId) > 0) {
      await conn.query(
        `ALTER TABLE \`${CENTER_DB}\`.\`${CENTER_TABLE}\` AUTO_INCREMENT = ?`,
        [Number(maxId) + 1],
      );
    }

    const [centerRows] = await conn.query(
      `SELECT id, username, email, department, status
       FROM \`${CENTER_DB}\`.\`${CENTER_TABLE}\`
       ORDER BY id`,
    );

    console.log(
      JSON.stringify(
        {
          center: `${CENTER_DB}.${CENTER_TABLE}`,
          source: `${SOURCE_DB}.users`,
          source_count: sourceUsers.length,
          inserted,
          updated,
          center_users: centerRows,
        },
        null,
        2,
      ),
    );
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
