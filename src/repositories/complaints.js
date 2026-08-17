/** Data access for Complaint records and shared masters. */
import { canonicalizeDepartmentName } from "../utils/department-map.js";
import { publicApiPath } from "../core/config.js";
import { createRecordProblemsHelper } from "./record-problems.js";

export function createComplaintRepository(pool) {
  const recordProblems = createRecordProblemsHelper(pool);
  const detailSelect = `
    SELECT
      cr.*,
      c.name AS company_name,
      c.name_en AS company_name_en,
      COALESCE(NULLIF(TRIM(c.name_en), ''), ca.name) AS customer_alias_name,
      f.name AS flute_name,
      m.name AS machine_name,
      p.name AS problem_name,
      p.name_en AS problem_name_en,
      reported.name AS reported_by_department_name,
      responsible.name AS responsible_department_name,
      cs_user.display_name AS cs_submitted_by_name,
      cs_user.department AS cs_submitted_by_department,
      created_user.department AS created_by_department,
      qa_user.display_name AS qa_submitted_by_name,
      dept_user.display_name AS department_submitted_by_name,
      confirm_user.display_name AS confirmed_by_name,
      CASE
        WHEN cr.doc_forward_date IS NOT NULL
         AND cr.doc_reply_date IS NOT NULL
         AND cr.doc_reply_date >= cr.doc_forward_date
        THEN DATEDIFF(cr.doc_reply_date, cr.doc_forward_date)
        ELSE NULL
      END AS lead_time_days
    FROM complaint_records cr
    LEFT JOIN companies c ON c.id = cr.company_id
    LEFT JOIN customer_aliases ca ON ca.id = cr.customer_alias_id
    LEFT JOIN flutes f ON f.id = cr.flute_id
    LEFT JOIN machines m ON m.id = cr.machine_id
    LEFT JOIN problems p ON p.id = cr.problem_id
    LEFT JOIN departments reported ON reported.id = cr.reported_by_department_id
    LEFT JOIN departments responsible ON responsible.id = cr.responsible_department_id
    LEFT JOIN users cs_user ON cs_user.id = cr.cs_submitted_by
    LEFT JOIN users created_user ON created_user.id = cr.created_by
    LEFT JOIN users qa_user ON qa_user.id = cr.qa_submitted_by
    LEFT JOIN users dept_user ON dept_user.id = cr.department_submitted_by
    LEFT JOIN users confirm_user ON confirm_user.id = cr.confirmed_by
  `;

  const inboxSelect = `
    SELECT
      cr.id,
      cr.pdr_no,
      cr.ng_qty,
      cr.received_date,
      cr.document_accepted,
      cr.workflow_status,
      c.name AS company_name,
      COALESCE(
        NULLIF((
          SELECT GROUP_CONCAT(p2.name ORDER BY crp.sort_order SEPARATOR ' · ')
            FROM complaint_record_problems crp
            INNER JOIN problems p2 ON p2.id = crp.problem_id
           WHERE crp.complaint_id = cr.id
        ), ''),
        p.name
      ) AS problem_name
    FROM complaint_records cr
    LEFT JOIN companies c ON c.id = cr.company_id
    LEFT JOIN problems p ON p.id = cr.problem_id
    LEFT JOIN departments responsible ON responsible.id = cr.responsible_department_id
  `;

  async function resolveMasterId(table, name) {
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
      const [result] = await pool.query(
        `INSERT INTO departments (name, is_active) VALUES (?, 1)`,
        [clean],
      );
      return result.insertId;
    }

    const [rows] = await pool.query(`SELECT id FROM ${table} WHERE name = ? LIMIT 1`, [clean]);
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
      // Prefer exact match so idx_complaint_pdr can be used; fall back to TRIM
      // for legacy rows that were stored with surrounding whitespace.
      const [exact] = await pool.query(
        `${detailSelect}
         WHERE cr.pdr_no = ?
         ORDER BY cr.received_date DESC, cr.id DESC`,
        [clean],
      );
      if (exact.length) return recordProblems.attachComplaintRows(exact);
      const [trimmed] = await pool.query(
        `${detailSelect}
         WHERE TRIM(cr.pdr_no) = ?
         ORDER BY cr.received_date DESC, cr.id DESC`,
        [clean],
      );
      return recordProblems.attachComplaintRows(trimmed);
    },

    async findById(id) {
      const [rows] = await pool.query(
        `${detailSelect} WHERE cr.id = ? LIMIT 1`,
        [id],
      );
      return recordProblems.attachComplaint(rows[0] || null);
    },

    async listInbox({ whereSql, params = [], q, limit, offset }) {
      const filters = [whereSql];
      const values = [...params];
      const keyword = String(q || "").trim();
      if (keyword) {
        filters.push(
          `(cr.pdr_no LIKE ? OR c.name LIKE ? OR p.name LIKE ? OR COALESCE(responsible.name, '') LIKE ?
            OR EXISTS (
              SELECT 1 FROM complaint_record_problems crp
              INNER JOIN problems px ON px.id = crp.problem_id
              WHERE crp.complaint_id = cr.id AND px.name LIKE ?
            ))`,
        );
        const like = `%${keyword}%`;
        values.push(like, like, like, like, like);
      }
      const where = `WHERE ${filters.join(" AND ")}`;

      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM complaint_records cr
         LEFT JOIN companies c ON c.id = cr.company_id
         LEFT JOIN problems p ON p.id = cr.problem_id
         LEFT JOIN departments responsible ON responsible.id = cr.responsible_department_id
         ${where}`,
        values,
      );
      const [rows] = await pool.query(
        `${inboxSelect}
         ${where}
         ORDER BY
           CASE cr.workflow_status
             WHEN 'pending_qa' THEN 1
             WHEN 'qa_review' THEN 2
             WHEN 'pending_department' THEN 3
             WHEN 'department_action' THEN 4
             WHEN 'qa_confirm' THEN 5
             WHEN 'cs_draft' THEN 6
             ELSE 7
           END,
           cr.received_date DESC,
           cr.id DESC
         LIMIT ? OFFSET ?`,
        [...values, limit, offset],
      );
      return { rows, total: Number(countRows[0]?.total || 0) };
    },

    async countInbox({ whereSql, params = [] }) {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM complaint_records cr
         LEFT JOIN departments responsible ON responsible.id = cr.responsible_department_id
         WHERE ${whereSql}`,
        params,
      );
      return Number(rows[0]?.total || 0);
    },

    async listAttachments(complaintId, { includeStoredName = false } = {}) {
      const [rows] = await pool.query(
        `SELECT
           ca.id,
           ca.kind,
           ca.original_name,
           ca.stored_name,
           ca.mime_type,
           ca.file_size,
           ca.created_at,
           u.display_name AS uploaded_by_name
         FROM complaint_attachments ca
         LEFT JOIN users u ON u.id = ca.uploaded_by
         WHERE ca.complaint_id = ?
         ORDER BY ca.kind ASC, ca.created_at ASC, ca.id ASC`,
        [complaintId],
      );
      return rows.map((row) => {
        const base = {
          id: row.id,
          kind: row.kind === "signature" ? "signature" : "file",
          original_name: row.original_name,
          mime_type: row.mime_type,
          file_size: row.file_size,
          created_at: row.created_at,
          uploaded_by_name: row.uploaded_by_name,
          url: publicApiPath(`/api/complaint-attachments/${row.id}/download`),
        };
        if (includeStoredName) base.stored_name = row.stored_name;
        return base;
      });
    },

    async findAttachmentById(id) {
      const [rows] = await pool.query(
        `SELECT * FROM complaint_attachments WHERE id = ? LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async createAttachments(complaintId, files, uploadedBy, kind = "file") {
      const attachmentKind = kind === "signature" ? "signature" : "file";
      const ids = [];
      for (const file of files) {
        const [result] = await pool.query(
          `INSERT INTO complaint_attachments
             (complaint_id, kind, original_name, stored_name, mime_type, file_size, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            complaintId,
            attachmentKind,
            file.originalname,
            file.filename,
            file.mimetype || null,
            file.size || 0,
            uploadedBy || null,
          ],
        );
        ids.push(result.insertId);
      }
      return ids;
    },

    async updatePlanFormJson(id, planForm) {
      await pool.query(`UPDATE complaint_records SET plan_form_json = ? WHERE id = ?`, [
        planForm == null ? null : JSON.stringify(planForm),
        id,
      ]);
    },

    async deleteAttachments(complaintId, attachmentIds) {
      const ids = [...new Set(attachmentIds)]
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0);
      if (!ids.length) return [];

      const placeholders = ids.map(() => "?").join(", ");
      const [rows] = await pool.query(
        `SELECT id, stored_name
         FROM complaint_attachments
         WHERE complaint_id = ? AND id IN (${placeholders})`,
        [complaintId, ...ids],
      );
      if (!rows.length) return [];

      await pool.query(
        `DELETE FROM complaint_attachments
         WHERE complaint_id = ? AND id IN (${placeholders})`,
        [complaintId, ...ids],
      );
      return rows;
    },

    resolveCompanyId(name) {
      return resolveMasterId("companies", name);
    },
    resolveFluteId(name) {
      return resolveMasterId("flutes", name);
    },
    resolveMachineId(name) {
      return resolveMasterId("machines", name);
    },
    resolveDepartmentId(name) {
      return resolveMasterId("departments", name);
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

    async createFromErp({
      pdrNo,
      companyId = null,
      customerAliasId = null,
      fluteId = null,
      machineId = null,
      orderNo = null,
      productName = null,
      paperM5 = null,
      paperM4 = null,
      paperM3 = null,
      paperM2 = null,
      paperM1 = null,
      planNo = null,
      shift = null,
      deliveryDate = null,
      productionDate = null,
      demandQty = null,
      grade = null,
      saleCsStaff = null,
      createdBy = null,
    }) {
      const [result] = await pool.query(
        `INSERT INTO complaint_records (
           company_id, customer_alias_id, flute_id, machine_id,
           pdr_no, order_no, product_name,
           paper_m5, paper_m4, paper_m3, paper_m2, paper_m1,
           plan_no, shift, delivery_date, production_date,
           demand_qty, grade, sale_cs_staff,
           workflow_status, created_by, updated_by
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cs_draft', ?, NULL)`,
        [
          companyId,
          customerAliasId,
          fluteId,
          machineId,
          pdrNo,
          orderNo,
          productName,
          paperM5,
          paperM4,
          paperM3,
          paperM2,
          paperM1,
          planNo,
          shift,
          deliveryDate,
          productionDate,
          demandQty,
          grade,
          saleCsStaff,
          createdBy,
        ],
      );
      return result.insertId;
    },

    async resolveProblemId(name, nameEn) {
      const clean = String(name || "").trim();
      if (!clean) return null;
      const [rows] = await pool.query(`SELECT id FROM problems WHERE name = ? LIMIT 1`, [clean]);
      if (rows[0]) {
        if (nameEn != null) {
          await pool.query(`UPDATE problems SET name_en = ? WHERE id = ?`, [
            String(nameEn).trim() || null,
            rows[0].id,
          ]);
        }
        return rows[0].id;
      }
      const [result] = await pool.query(
        `INSERT INTO problems (name, name_en, is_active) VALUES (?, ?, 1)`,
        [clean, String(nameEn || "").trim() || null],
      );
      return result.insertId;
    },

    async resolveProblemIds(names, nameEn) {
      const ids = [];
      const seen = new Set();
      for (let index = 0; index < (names || []).length; index += 1) {
        const id = await this.resolveProblemId(
          names[index],
          index === 0 ? nameEn : undefined,
        );
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      return ids;
    },

    replaceProblems(complaintId, problemIds) {
      return recordProblems.replaceComplaintProblems(complaintId, problemIds);
    },

    async updateById(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return false;
      const values = keys.map((key) => fields[key]);
      values.push(id);
      const [result] = await pool.query(
        `UPDATE complaint_records SET ${keys.map((key) => `${key} = ?`).join(", ")}
         WHERE id = ?`,
        values,
      );
      return result.affectedRows > 0;
    },

    /**
     * Next Action Plan number: AP{YY}-{NNN}
     * Sequence follows the highest existing AP{YY}-### only (other prefixes ignored).
     * Resets when the calendar year changes.
     * Uses MySQL named lock so concurrent callers never mint the same preview/save number.
     */
    async getNextApDocumentNo(year = new Date().getFullYear()) {
      return this.claimApDocumentNo(null, { year, persist: false });
    },

    /**
     * Reserve a unique AP number under a named lock.
     * - preferred: keep if free (or already owned by excludeComplaintId)
     * - otherwise mint next AP{YY}-{NNN}
     * When persist=true, writes document_no before releasing the lock so two
     * concurrent saves cannot both keep the same number.
     */
    async claimApDocumentNo(
      preferred = null,
      {
        year = new Date().getFullYear(),
        excludeComplaintId = null,
        persist = false,
      } = {},
    ) {
      const yy = String(year).slice(-2);
      const prefix = `AP${yy}-`;
      const lockName = `cms_ap_doc_${yy}`;
      const conn = await pool.getConnection();
      try {
        const [[lockRow]] = await conn.query(`SELECT GET_LOCK(?, 10) AS ok`, [
          lockName,
        ]);
        if (Number(lockRow?.ok) !== 1) {
          const error = new Error(
            "มีผู้ออกเลขเอกสารพร้อมกัน กรุณาลองใหม่ในสักครู่",
          );
          error.status = 409;
          throw error;
        }

        let nextNo = null;
        const preferredClean = String(preferred || "").trim();
        if (preferredClean) {
          const [owned] = await conn.query(
            `SELECT id FROM complaint_records
             WHERE document_no = ?
             LIMIT 1`,
            [preferredClean],
          );
          const ownerId = owned[0] ? Number(owned[0].id) : null;
          if (
            ownerId == null ||
            (excludeComplaintId != null &&
              ownerId === Number(excludeComplaintId))
          ) {
            nextNo = preferredClean;
          }
        }

        if (!nextNo) {
          const [rows] = await conn.query(
            `SELECT document_no
             FROM complaint_records
             WHERE document_no LIKE ?
               AND document_no REGEXP ?
             ORDER BY CAST(SUBSTRING_INDEX(document_no, '-', -1) AS UNSIGNED) DESC
             LIMIT 1`,
            [`${prefix}%`, `^AP${yy}-[0-9]+$`],
          );
          const match = String(rows[0]?.document_no || "")
            .trim()
            .match(/^AP\d{2}-(\d+)$/i);
          const maxSeq = match ? Number(match[1]) : 0;
          nextNo = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
        }

        if (persist && excludeComplaintId != null) {
          await conn.query(
            `UPDATE complaint_records
             SET document_no = ?
             WHERE id = ?`,
            [nextNo, Number(excludeComplaintId)],
          );
        }

        return nextNo;
      } finally {
        try {
          await conn.query(`SELECT RELEASE_LOCK(?)`, [lockName]);
        } catch {
          /* ignore */
        }
        conn.release();
      }
    },
  };
}
