import { parsePagination, paginatedJson } from "../validators/common.js";

export function createActivityLogRepository(pool) {
  return {
    async create({
      userId = null,
      username = null,
      displayName = null,
      department = null,
      action,
      entityType,
      entityId = null,
      summary,
      changes = null,
    }) {
      const [result] = await pool.query(
        `INSERT INTO activity_logs
           (user_id, username, display_name, department, action, entity_type, entity_id, summary, changes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          username,
          displayName,
          department,
          action,
          entityType,
          entityId,
          summary,
          changes == null ? null : JSON.stringify(changes),
        ],
      );
      return result.insertId;
    },

    async findDepartmentAcceptedAt(complaintId) {
      const id = Number(complaintId);
      if (!Number.isInteger(id) || id <= 0) return null;
      const [rows] = await pool.query(
        `SELECT created_at, summary, changes_json
         FROM activity_logs
         WHERE entity_type = 'complaint_record'
           AND entity_id = ?
           AND action = 'accept'
         ORDER BY created_at DESC, id DESC
         LIMIT 30`,
        [id],
      );
      for (const row of rows) {
        let changes = row.changes_json;
        if (typeof changes === "string") {
          try {
            changes = JSON.parse(changes);
          } catch {
            changes = null;
          }
        }
        const toDepartment = Array.isArray(changes)
          ? changes.some(
              (change) =>
                change?.field === "workflow_status" &&
                change?.after === "department_action",
            )
          : false;
        const summary = String(row.summary || "");
        const looksLikeDepartmentAccept =
          toDepartment ||
          (summary.includes("รับเรื่อง") && !summary.startsWith("QA รับเรื่อง"));
        if (looksLikeDepartmentAccept) return row.created_at;
      }
      return null;
    },

    async list(params = {}) {
      const { page, pageSize, offset } = parsePagination(params);
      const where = [];
      const values = [];

      const q = String(params.q || "").trim();
      if (q) {
        where.push(
          `(summary LIKE ? OR username LIKE ? OR display_name LIKE ? OR department LIKE ? OR action LIKE ?)`,
        );
        const like = `%${q}%`;
        values.push(like, like, like, like, like);
      }

      if (params.action) {
        where.push("action = ?");
        values.push(String(params.action));
      }

      if (params.entity_type) {
        where.push("entity_type = ?");
        values.push(String(params.entity_type));
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM activity_logs ${whereSql}`,
        values,
      );
      const [rows] = await pool.query(
        `SELECT id, user_id, username, display_name, department, action, entity_type, entity_id,
                summary, changes_json, created_at
         FROM activity_logs
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...values, pageSize, offset],
      );

      return paginatedJson(
        rows.map((row) => ({
          ...row,
          changes:
            typeof row.changes_json === "string"
              ? JSON.parse(row.changes_json)
              : row.changes_json,
          changes_json: undefined,
        })),
        Number(total),
        { page, pageSize },
      );
    },
  };
}
