/** Data access for Reject records. */
import { canonicalizeDepartmentName } from "../utils/department-map.js";
import { createRecordProblemsHelper } from "./record-problems.js";

export function createRejectRepository(pool) {
  const recordProblems = createRecordProblemsHelper(pool);
  const detailSelect = `
    SELECT
      rr.*,
      c.name AS company_name,
      ca.name AS customer_alias_name,
      d.name AS department_name,
      m.name AS machine_name,
      p.name AS problem_name,
      f.name AS flute_name
    FROM reject_records rr
    LEFT JOIN companies c ON c.id = rr.company_id
    LEFT JOIN customer_aliases ca ON ca.id = rr.customer_alias_id
    LEFT JOIN departments d ON d.id = rr.department_id
    LEFT JOIN machines m ON m.id = rr.machine_id
    LEFT JOIN problems p ON p.id = rr.problem_id
    LEFT JOIN complaint_records cr ON cr.id = rr.source_complaint_id
    LEFT JOIN flutes f ON f.id = COALESCE(rr.flute_id, cr.flute_id)
  `;

  const listSelect = `
    SELECT
      rr.id,
      rr.pdr_no,
      rr.source,
      rr.created_at,
      c.name AS company_name,
      COALESCE(
        NULLIF((
          SELECT GROUP_CONCAT(p2.name ORDER BY rrp.sort_order SEPARATOR ' · ')
            FROM reject_record_problems rrp
            INNER JOIN problems p2 ON p2.id = rrp.problem_id
           WHERE rrp.reject_id = rr.id
        ), ''),
        p.name
      ) AS problem_name,
      m.name AS machine_name
    FROM reject_records rr
    LEFT JOIN companies c ON c.id = rr.company_id
    LEFT JOIN problems p ON p.id = rr.problem_id
    LEFT JOIN machines m ON m.id = rr.machine_id
  `;

  async function findMasterIdByName(table, name) {
    const clean =
      table === "departments"
        ? canonicalizeDepartmentName(name)
        : String(name || "").trim();
    if (!clean) return null;

    if (table === "departments") {
      const [rows] = await pool.query(
        `SELECT id FROM departments
         WHERE LOWER(name) = LOWER(?)
         ORDER BY is_active DESC, id ASC
         LIMIT 1`,
        [clean],
      );
      if (rows[0]) return rows[0].id;
      // Do not recreate legacy junk — only insert known master codes
      const [result] = await pool.query(
        `INSERT INTO departments (name, is_active) VALUES (?, 1)`,
        [clean],
      );
      return result.insertId;
    }

    const [rows] = await pool.query(
      `SELECT id FROM ${table} WHERE name = ? LIMIT 1`,
      [clean],
    );
    if (rows[0]) return rows[0].id;
    const [result] = await pool.query(
      `INSERT INTO ${table} (name, is_active) VALUES (?, 1)`,
      [clean],
    );
    return result.insertId;
  }

  return {
    async findByPdr(pdrNo) {
      const clean = String(pdrNo || "").trim();
      if (!clean) return [];
      // Prefer exact match so idx_reject_pdr can be used; fall back to TRIM
      // for legacy rows that were stored with surrounding whitespace.
      const [exact] = await pool.query(
        `${detailSelect}
         WHERE rr.pdr_no = ?
         ORDER BY rr.reject_received_date DESC, rr.id DESC`,
        [clean],
      );
      if (exact.length) return recordProblems.attachRejectRows(exact);
      const [trimmed] = await pool.query(
        `${detailSelect}
         WHERE TRIM(rr.pdr_no) = ?
         ORDER BY rr.reject_received_date DESC, rr.id DESC`,
        [clean],
      );
      return recordProblems.attachRejectRows(trimmed);
    },

    async findById(id) {
      const [rows] = await pool.query(
        `${detailSelect}
         WHERE rr.id = ?
         LIMIT 1`,
        [id],
      );
      return recordProblems.attachReject(rows[0] || null);
    },

    async findBySourceComplaintId(complaintId) {
      const [rows] = await pool.query(
        `${detailSelect}
         WHERE rr.source_complaint_id = ?
         ORDER BY rr.id DESC
         LIMIT 1`,
        [complaintId],
      );
      return recordProblems.attachReject(rows[0] || null);
    },

    async findRelatedForComplaint(complaint) {
      const byId = new Map();
      if (complaint?.id) {
        const linked = await this.findBySourceComplaintId(complaint.id);
        if (linked) byId.set(Number(linked.id), linked);
      }
      const pdrNo = String(complaint?.pdr_no || "").trim();
      if (pdrNo) {
        for (const row of await this.findByPdr(pdrNo)) {
          byId.set(Number(row.id), row);
        }
      }
      return [...byId.values()];
    },

    async deleteById(id) {
      const [result] = await pool.query(
        `DELETE FROM reject_records WHERE id = ?`,
        [id],
      );
      return result.affectedRows > 0;
    },

    async list({ source = null, q = "", limit = 20, offset = 0 } = {}) {
      const clauses = [];
      const params = [];

      if (source) {
        clauses.push("rr.source = ?");
        params.push(source);
      }

      const keyword = String(q || "").trim();
      if (keyword) {
        const like = `%${keyword}%`;
        clauses.push(
          `(rr.pdr_no LIKE ? OR COALESCE(c.name, '') LIKE ? OR COALESCE(p.name, '') LIKE ?
            OR EXISTS (
              SELECT 1 FROM reject_record_problems rrp
              INNER JOIN problems px ON px.id = rrp.problem_id
              WHERE rrp.reject_id = rr.id AND px.name LIKE ?
            ))`,
        );
        params.push(like, like, like, like);
      }

      const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM reject_records rr
         LEFT JOIN companies c ON c.id = rr.company_id
         LEFT JOIN problems p ON p.id = rr.problem_id
         ${whereSql}`,
        params,
      );

      const [rows] = await pool.query(
        `${listSelect}
         ${whereSql}
         ORDER BY rr.created_at DESC, rr.id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      );

      return { rows, total: Number(countRows[0]?.total || 0) };
    },

    async createStub({
      pdrNo,
      companyId = null,
      customerAliasId = null,
      machineId = null,
      fluteId = null,
      problemId = null,
      departmentId = null,
      shift = null,
      productionDate = null,
      sourceComplaintId,
      createdBy = null,
      remark = null,
    }) {
      const [result] = await pool.query(
        `INSERT INTO reject_records (
           pdr_no, company_id, customer_alias_id, machine_id, flute_id, problem_id, department_id,
           shift, production_date, source, source_complaint_id, remark, created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'complaint', ?, ?, ?, NULL)`,
        [
          pdrNo,
          companyId,
          customerAliasId,
          machineId,
          fluteId,
          problemId,
          departmentId,
          shift,
          productionDate,
          sourceComplaintId,
          remark,
          createdBy,
        ],
      );
      return result.insertId;
    },

    async createFromErp({
      pdrNo,
      companyId = null,
      customerAliasId = null,
      machineId = null,
      fluteId = null,
      saleOrderNo = null,
      orderQty = null,
      size = null,
      cutQty = null,
      itemCode = null,
      bigSheetQty = null,
      bigSheetSize = null,
      smallSheetSize = null,
      shift = null,
      vehiclePlate = null,
      customerShipDate = null,
      productionDate = null,
      weightPerSheet = null,
      pricePerSheet = null,
      problemId = null,
      departmentId = null,
      remark = null,
      source = "erp",
      sourceComplaintId = null,
      createdBy = null,
    }) {
      const sourceValue = source === "complaint" ? "complaint" : "erp";
      const [result] = await pool.query(
        `INSERT INTO reject_records (
           pdr_no, company_id, customer_alias_id, machine_id, flute_id,
           sale_order_no, order_qty, size,
           cut_qty, item_code, big_sheet_qty, big_sheet_size, small_sheet_size,
           shift, vehicle_plate,
           customer_ship_date, production_date,
           weight_per_sheet, price_per_sheet,
           problem_id, department_id, remark,
           source, source_complaint_id,
           created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          pdrNo,
          companyId,
          customerAliasId,
          machineId,
          fluteId,
          saleOrderNo,
          orderQty,
          size,
          cutQty,
          itemCode,
          bigSheetQty,
          bigSheetSize,
          smallSheetSize,
          shift,
          vehiclePlate,
          customerShipDate,
          productionDate,
          weightPerSheet,
          pricePerSheet,
          problemId,
          departmentId,
          remark,
          sourceValue,
          sourceComplaintId,
          createdBy,
        ],
      );
      return result.insertId;
    },

    resolveCompanyId(name) {
      return findMasterIdByName("companies", name);
    },

    resolveFluteId(name) {
      return findMasterIdByName("flutes", name);
    },

    resolveMachineId(name) {
      return findMasterIdByName("machines", name);
    },

    async resolveAliasId(companyId, name) {
      const clean = String(name || "").trim();
      if (!companyId || !clean) return null;
      const [rows] = await pool.query(
        `SELECT id FROM customer_aliases WHERE company_id = ? AND name = ? LIMIT 1`,
        [companyId, clean],
      );
      if (rows[0]) return rows[0].id;
      const [result] = await pool.query(
        `INSERT INTO customer_aliases (company_id, name, is_active) VALUES (?, ?, 1)`,
        [companyId, clean],
      );
      return result.insertId;
    },

    async resolveDepartmentId(name) {
      return findMasterIdByName("departments", name);
    },

    async resolveProblemId(name) {
      return findMasterIdByName("problems", name);
    },

    async resolveProblemIds(names) {
      const ids = [];
      const seen = new Set();
      for (const name of names || []) {
        const id = await findMasterIdByName("problems", name);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      return ids;
    },

    replaceProblems(rejectId, problemIds) {
      return recordProblems.replaceRejectProblems(rejectId, problemIds);
    },

    async updateById(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return false;
      const sets = keys.map((key) => `${key} = ?`);
      const values = keys.map((key) => fields[key]);
      values.push(id);
      const [result] = await pool.query(
        `UPDATE reject_records SET ${sets.join(", ")} WHERE id = ?`,
        values,
      );
      return result.affectedRows > 0;
    },
  };
}
