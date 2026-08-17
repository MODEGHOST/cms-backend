/** Junction-table helpers for multi-select ปัญหา on complaint / reject records. */

import { logger } from "../core/logger.js";
import { applyProblemsToRecord } from "../utils/problem-names.js";

export function isUnknownColumnError(err) {
  return (
    err?.code === "ER_BAD_FIELD_ERROR" ||
    Number(err?.errno) === 1054 ||
    /Unknown column/i.test(String(err?.message || ""))
  );
}

function isDeadlockError(err) {
  return (
    err?.code === "ER_LOCK_DEADLOCK" ||
    Number(err?.errno) === 1213 ||
    /Deadlock/i.test(String(err?.message || ""))
  );
}

function isMissingTableError(err) {
  return (
    err?.code === "ER_NO_SUCH_TABLE" ||
    Number(err?.errno) === 1146 ||
    /doesn't exist/i.test(String(err?.message || ""))
  );
}

export async function updateRecordFields(updateById, id, fields) {
  try {
    return await updateById(id, fields);
  } catch (err) {
    if (
      !Object.prototype.hasOwnProperty.call(fields, "problem_names_json") ||
      !isUnknownColumnError(err)
    ) {
      throw err;
    }
    logger.warn("record_problems.json_column_missing", { id });
    const { problem_names_json: _omit, ...rest } = fields;
    return updateById(id, rest);
  }
}

/**
 * Write multi-problem junction. Does not swallow failures (no silent success).
 * replaceFor itself is hardened (transaction + valid FK ids + deadlock retry).
 */
export async function replaceProblemsSafe(replaceFn, id, problemIds) {
  try {
    await replaceFn(id, problemIds);
  } catch (err) {
    logger.error("record_problems.replace_failed", {
      id,
      error: err?.message || String(err),
    });
    if (isMissingTableError(err)) {
      const error = new Error(
        "ระบบยังไม่พร้อมบันทึกหลายปัญหา กรุณารีสตาร์ทเซิร์ฟเวอร์แล้วลองใหม่",
      );
      error.status = 503;
      throw error;
    }
    const error = new Error(
      err?.message && !/^[A-Z_]+$/.test(String(err.message))
        ? err.message
        : "บันทึกรายการปัญหาไม่สำเร็จ กรุณาลองใหม่",
    );
    error.status = err?.status || 500;
    throw error;
  }
}

export function createRecordProblemsHelper(pool) {
  async function listFor(table, fkColumn, recordId) {
    const id = Number(recordId);
    if (!Number.isInteger(id) || id <= 0) return [];
    const [rows] = await pool.query(
      `SELECT p.id, p.name, p.name_en, rp.sort_order
         FROM ${table} rp
         INNER JOIN problems p ON p.id = rp.problem_id
        WHERE rp.${fkColumn} = ?
        ORDER BY rp.sort_order ASC, p.name ASC`,
      [id],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      name_en: row.name_en || null,
    }));
  }

  async function listForMany(table, fkColumn, recordIds) {
    const ids = [
      ...new Set(
        (recordIds || [])
          .map(Number)
          .filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    const map = new Map();
    if (!ids.length) return map;
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await pool.query(
      `SELECT rp.${fkColumn} AS record_id, p.id, p.name, p.name_en, rp.sort_order
         FROM ${table} rp
         INNER JOIN problems p ON p.id = rp.problem_id
        WHERE rp.${fkColumn} IN (${placeholders})
        ORDER BY rp.${fkColumn} ASC, rp.sort_order ASC, p.name ASC`,
      ids,
    );
    for (const row of rows) {
      const recordId = Number(row.record_id);
      const list = map.get(recordId) || [];
      list.push({
        id: row.id,
        name: row.name,
        name_en: row.name_en || null,
      });
      map.set(recordId, list);
    }
    return map;
  }

  async function replaceForOnce(conn, table, fkColumn, id, unique) {
    await conn.query(`DELETE FROM ${table} WHERE ${fkColumn} = ?`, [id]);
    if (!unique.length) return;

    // Drop stale/missing problem ids so FK constraints never blow up mid-save.
    const idPlaceholders = unique.map(() => "?").join(", ");
    const [existing] = await conn.query(
      `SELECT id FROM problems WHERE id IN (${idPlaceholders})`,
      unique,
    );
    const existingSet = new Set(existing.map((row) => Number(row.id)));
    const valid = unique.filter((problemId) => existingSet.has(problemId));
    if (!valid.length) return;

    const insertPlaceholders = valid.map(() => "(?, ?, ?)").join(", ");
    const values = valid.flatMap((problemId, index) => [id, problemId, index]);
    await conn.query(
      `INSERT INTO ${table} (${fkColumn}, problem_id, sort_order)
       VALUES ${insertPlaceholders}`,
      values,
    );
  }

  async function replaceFor(table, fkColumn, recordId, problemIds) {
    const id = Number(recordId);
    if (!Number.isInteger(id) || id <= 0) return;
    const unique = [];
    const seen = new Set();
    for (const raw of problemIds || []) {
      const problemId = Number(raw);
      if (!Number.isInteger(problemId) || problemId <= 0 || seen.has(problemId)) {
        continue;
      }
      seen.add(problemId);
      unique.push(problemId);
    }

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await replaceForOnce(conn, table, fkColumn, id, unique);
        await conn.commit();
        return;
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          /* ignore */
        }
        if (attempt < 2 && isDeadlockError(err)) continue;
        throw err;
      } finally {
        conn.release();
      }
    }
  }

  async function attachMany(table, fkColumn, rows) {
    if (!Array.isArray(rows) || !rows.length) return rows || [];
    const map = await listForMany(
      table,
      fkColumn,
      rows.map((row) => row?.id),
    );
    return rows.map((row) =>
      applyProblemsToRecord(row, map.get(Number(row?.id)) || []),
    );
  }

  return {
    listFor,
    listForMany,
    replaceFor,
    attachMany,
    async listComplaintProblems(complaintId) {
      return listFor("complaint_record_problems", "complaint_id", complaintId);
    },
    async listRejectProblems(rejectId) {
      return listFor("reject_record_problems", "reject_id", rejectId);
    },
    async replaceComplaintProblems(complaintId, problemIds) {
      return replaceFor(
        "complaint_record_problems",
        "complaint_id",
        complaintId,
        problemIds,
      );
    },
    async replaceRejectProblems(rejectId, problemIds) {
      return replaceFor(
        "reject_record_problems",
        "reject_id",
        rejectId,
        problemIds,
      );
    },
    async attachComplaintRows(rows) {
      return attachMany("complaint_record_problems", "complaint_id", rows);
    },
    async attachRejectRows(rows) {
      return attachMany("reject_record_problems", "reject_id", rows);
    },
    async attachComplaint(record) {
      if (!record?.id) return record;
      const problems = await listFor(
        "complaint_record_problems",
        "complaint_id",
        record.id,
      );
      return applyProblemsToRecord(record, problems);
    },
    async attachReject(record) {
      if (!record?.id) return record;
      const problems = await listFor(
        "reject_record_problems",
        "reject_id",
        record.id,
      );
      return applyProblemsToRecord(record, problems);
    },
  };
}
