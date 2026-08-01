/**
 * Migrate CMS auth to shared identity (lfbsmart_project.users).
 *
 * - Upsert CMS users into shared DB (by username)
 * - Remap cms FK user ids -> shared user ids
 * - Rebuild cms.users as local profiles (same id as shared)
 * - Create cms_memberships with CMS-only roles
 * - Optionally grant CMS access to existing shared users
 *
 * Safe-ish to re-run: skips if cms_memberships already populated and users already aligned.
 */
import "../src/core/load-env.js";
import mysql from "mysql2/promise";
import { config } from "../src/core/config.js";

const SHARED_DB = config.sharedDbName;
const CMS_DB = config.db.database;

const FK_UPDATES = [
  ["reject_records", ["created_by", "updated_by"]],
  [
    "complaint_records",
    [
      "cs_submitted_by",
      "qa_submitted_by",
      "department_submitted_by",
      "confirmed_by",
      "created_by",
      "updated_by",
    ],
  ],
  ["complaint_attachments", ["uploaded_by"]],
  ["activity_logs", ["user_id"]],
];

function splitName(displayName) {
  const parts = String(displayName || "").trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "User",
    lastName: parts.slice(1).join(" ") || "-",
    fullName: parts.join(" ") || "User",
  };
}

function localEmail(username) {
  return `${String(username).toLowerCase()}@cms.local`;
}

async function tableExists(conn, schema, table) {
  const [rows] = await conn.query(
    `SELECT 1 AS ok
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     LIMIT 1`,
    [schema, table],
  );
  return rows.length > 0;
}

async function ensureMembershipsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS cms_memberships (
      user_id BIGINT UNSIGNED NOT NULL,
      role ENUM('admin', 'staff') NOT NULL DEFAULT 'staff',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_cms_memberships_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
}

async function findOrCreateSharedUser(conn, cmsUser) {
  const username = String(cmsUser.username).trim();
  const [[existing]] = await conn.query(
    `SELECT id, username, email, password_hash, status
     FROM \`${SHARED_DB}\`.users
     WHERE username = ?
     LIMIT 1`,
    [username],
  );
  if (existing) {
    return { id: Number(existing.id), created: false, reused: true };
  }

  const { firstName, lastName, fullName } = splitName(cmsUser.display_name);
  const email = localEmail(username);
  const [result] = await conn.query(
    `INSERT INTO \`${SHARED_DB}\`.users
       (name, first_name, last_name, email, username, password_hash, role, department, status, email_verified_at, token_version)
     VALUES (?, ?, ?, ?, ?, ?, 'requester', ?, 'active', CURRENT_TIMESTAMP, 0)`,
    [
      fullName,
      firstName,
      lastName,
      email,
      username,
      cmsUser.password_hash,
      cmsUser.department || null,
    ],
  );
  return { id: Number(result.insertId), created: true, reused: false };
}

async function remapForeignKeys(conn, idMap) {
  const entries = [...idMap.entries()].filter(([oldId, newId]) => oldId !== newId);
  if (!entries.length) return { updated: 0 };

  let updated = 0;
  for (const [table, columns] of FK_UPDATES) {
    if (!(await tableExists(conn, CMS_DB, table))) continue;
    for (const column of columns) {
      for (const [oldId, newId] of entries) {
        const [result] = await conn.query(
          `UPDATE \`${CMS_DB}\`.\`${table}\`
           SET \`${column}\` = ?
           WHERE \`${column}\` = ?`,
          [newId, oldId],
        );
        updated += Number(result.affectedRows || 0);
      }
    }
  }
  return { updated };
}

async function rebuildLocalUsers(conn, profiles) {
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    await conn.query("DELETE FROM cms_memberships");
    await conn.query("DELETE FROM users");

    for (const profile of profiles) {
      await conn.query(
        `INSERT INTO users
           (id, username, password_hash, display_name, role, department, is_active)
         VALUES (?, ?, '', ?, 'staff', ?, ?)`,
        [
          profile.id,
          profile.username,
          profile.display_name,
          profile.department,
          profile.is_active ? 1 : 0,
        ],
      );
      await conn.query(
        `INSERT INTO cms_memberships (user_id, role)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
        [profile.id, profile.role],
      );
    }

    const maxId = profiles.reduce((max, row) => Math.max(max, row.id), 0);
    if (maxId > 0) {
      await conn.query(`ALTER TABLE users AUTO_INCREMENT = ?`, [maxId + 1]);
    }
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

async function grantExistingSharedUsers(conn) {
  // Give known shared accounts CMS access so SSO works out of the box.
  const grants = [
    { username: "toni.admin", role: "admin", department: "Admin" },
    { username: "peerapon.it", role: "staff", department: "Development" },
  ];

  const granted = [];
  for (const grant of grants) {
    const [[shared]] = await conn.query(
      `SELECT id, username, name, first_name, last_name, department, status
       FROM \`${SHARED_DB}\`.users
       WHERE username = ?
       LIMIT 1`,
      [grant.username],
    );
    if (!shared || shared.status === "suspended") continue;

    const displayName =
      [shared.first_name, shared.last_name].filter(Boolean).join(" ").trim() ||
      shared.name ||
      shared.username;

    await conn.query(
      `INSERT INTO users
         (id, username, password_hash, display_name, role, department, is_active)
       VALUES (?, ?, '', ?, 'staff', ?, 1)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username),
         display_name = VALUES(display_name),
         department = COALESCE(VALUES(department), department),
         is_active = 1`,
      [
        shared.id,
        shared.username,
        displayName,
        grant.department || shared.department || null,
      ],
    );

    await conn.query(
      `INSERT INTO cms_memberships (user_id, role)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE role = VALUES(role)`,
      [shared.id, grant.role],
    );
    granted.push({ username: grant.username, user_id: shared.id, role: grant.role });
  }
  return granted;
}

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: CMS_DB,
    multipleStatements: true,
  });

  try {
    if (!(await tableExists(conn, SHARED_DB, "users"))) {
      throw new Error(
        `Shared identity table ${SHARED_DB}.users not found. Start PRD DB first.`,
      );
    }

    await ensureMembershipsTable(conn);

    const [cmsUsers] = await conn.query(
      `SELECT id, username, password_hash, display_name, role, department, is_active
       FROM users
       ORDER BY id ASC`,
    );

    const [[membershipCount]] = await conn.query(
      `SELECT COUNT(*) AS count FROM cms_memberships`,
    );

    // If already migrated (memberships exist and every local user id exists in shared), only grant extras.
    if (Number(membershipCount.count) > 0 && cmsUsers.length > 0) {
      const ids = cmsUsers.map((u) => Number(u.id));
      const [sharedHits] = await conn.query(
        `SELECT id FROM \`${SHARED_DB}\`.users WHERE id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      if (sharedHits.length === ids.length) {
        const granted = await grantExistingSharedUsers(conn);
        console.log(
          JSON.stringify(
            {
              skipped_remap: true,
              reason: "cms_memberships already present and user ids aligned",
              memberships: Number(membershipCount.count),
              granted_shared_users: granted,
            },
            null,
            2,
          ),
        );
        return;
      }
    }

    const idMap = new Map();
    const profiles = [];
    const createdShared = [];

    for (const cmsUser of cmsUsers) {
      const shared = await findOrCreateSharedUser(conn, cmsUser);
      const oldId = Number(cmsUser.id);
      const newId = Number(shared.id);
      idMap.set(oldId, newId);
      profiles.push({
        id: newId,
        username: cmsUser.username,
        display_name: cmsUser.display_name,
        role: cmsUser.role === "admin" ? "admin" : "staff",
        department: cmsUser.department || null,
        is_active: Number(cmsUser.is_active) === 1,
      });
      if (shared.created) {
        createdShared.push({ username: cmsUser.username, shared_id: newId });
      }
    }

    // Deduplicate profiles if two CMS users somehow map to same shared id (keep first / merge admin).
    const bySharedId = new Map();
    for (const profile of profiles) {
      const prev = bySharedId.get(profile.id);
      if (!prev) {
        bySharedId.set(profile.id, profile);
        continue;
      }
      bySharedId.set(profile.id, {
        ...prev,
        role: prev.role === "admin" || profile.role === "admin" ? "admin" : "staff",
        department: prev.department || profile.department,
        is_active: prev.is_active || profile.is_active,
      });
    }

    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    const remap = await remapForeignKeys(conn, idMap);
    await rebuildLocalUsers(conn, [...bySharedId.values()]);
    const granted = await grantExistingSharedUsers(conn);

    console.log(
      JSON.stringify(
        {
          shared_db: SHARED_DB,
          cms_db: CMS_DB,
          mapped_users: [...idMap.entries()].map(([oldId, newId]) => ({
            old_id: oldId,
            shared_id: newId,
          })),
          created_shared_users: createdShared,
          fk_rows_updated: remap.updated,
          memberships: bySharedId.size,
          granted_shared_users: granted,
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
