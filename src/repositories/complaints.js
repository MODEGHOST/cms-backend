/** Data access for Complaint records and shared masters. */
export function createComplaintRepository(pool) {
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
      qa_user.display_name AS qa_submitted_by_name,
      dept_user.display_name AS department_submitted_by_name,
      confirm_user.display_name AS confirmed_by_name
    FROM complaint_records cr
    LEFT JOIN companies c ON c.id = cr.company_id
    LEFT JOIN customer_aliases ca ON ca.id = cr.customer_alias_id
    LEFT JOIN flutes f ON f.id = cr.flute_id
    LEFT JOIN machines m ON m.id = cr.machine_id
    LEFT JOIN problems p ON p.id = cr.problem_id
    LEFT JOIN departments reported ON reported.id = cr.reported_by_department_id
    LEFT JOIN departments responsible ON responsible.id = cr.responsible_department_id
    LEFT JOIN users cs_user ON cs_user.id = cr.cs_submitted_by
    LEFT JOIN users qa_user ON qa_user.id = cr.qa_submitted_by
    LEFT JOIN users dept_user ON dept_user.id = cr.department_submitted_by
    LEFT JOIN users confirm_user ON confirm_user.id = cr.confirmed_by
  `;

  async function resolveMasterId(table, name) {
    const clean = String(name || "").trim();
    if (!clean) return null;
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
      const [rows] = await pool.query(
        `${detailSelect}
         WHERE TRIM(cr.pdr_no) = ?
         ORDER BY cr.received_date DESC, cr.id DESC`,
        [pdrNo],
      );
      return rows;
    },

    async findById(id) {
      const [rows] = await pool.query(
        `${detailSelect} WHERE cr.id = ? LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async listAttachments(complaintId) {
      const [rows] = await pool.query(
        `SELECT
           ca.id,
           ca.original_name,
           ca.mime_type,
           ca.file_size,
           ca.created_at,
           u.display_name AS uploaded_by_name
         FROM complaint_attachments ca
         LEFT JOIN users u ON u.id = ca.uploaded_by
         WHERE ca.complaint_id = ?
         ORDER BY ca.created_at ASC, ca.id ASC`,
        [complaintId],
      );
      return rows.map((row) => ({
        ...row,
        url: `/api/complaint-attachments/${row.id}/download`,
      }));
    },

    async findAttachmentById(id) {
      const [rows] = await pool.query(
        `SELECT * FROM complaint_attachments WHERE id = ? LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async createAttachments(complaintId, files, uploadedBy) {
      for (const file of files) {
        await pool.query(
          `INSERT INTO complaint_attachments
             (complaint_id, original_name, stored_name, mime_type, file_size, uploaded_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            complaintId,
            file.originalname,
            file.filename,
            file.mimetype || null,
            file.size || 0,
            uploadedBy || null,
          ],
        );
      }
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
     */
    async getNextApDocumentNo(year = new Date().getFullYear()) {
      const yy = String(year).slice(-2);
      const prefix = `AP${yy}-`;
      const [rows] = await pool.query(
        `SELECT document_no
         FROM complaint_records
         WHERE document_no LIKE ?`,
        [`${prefix}%`],
      );
      let maxSeq = 0;
      for (const row of rows) {
        const match = String(row.document_no || "").trim().match(/^AP\d{2}-(\d+)$/i);
        if (match) maxSeq = Math.max(maxSeq, Number(match[1]));
      }
      return `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
    },
  };
}
