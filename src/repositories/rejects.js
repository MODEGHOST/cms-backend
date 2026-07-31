/** Data access for Reject records. */
export function createRejectRepository(pool) {
  const detailSelect = `
    SELECT
      rr.*,
      c.name AS company_name,
      ca.name AS customer_alias_name,
      d.name AS department_name,
      m.name AS machine_name,
      p.name AS problem_name
    FROM reject_records rr
    LEFT JOIN companies c ON c.id = rr.company_id
    LEFT JOIN customer_aliases ca ON ca.id = rr.customer_alias_id
    LEFT JOIN departments d ON d.id = rr.department_id
    LEFT JOIN machines m ON m.id = rr.machine_id
    LEFT JOIN problems p ON p.id = rr.problem_id
  `;

  async function findMasterIdByName(table, name) {
    const clean = String(name || "").trim();
    if (!clean) return null;
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
      const [rows] = await pool.query(
        `${detailSelect}
         WHERE TRIM(rr.pdr_no) = ?
         ORDER BY rr.reject_received_date DESC, rr.id DESC`,
        [pdrNo],
      );
      return rows;
    },

    async findById(id) {
      const [rows] = await pool.query(
        `${detailSelect}
         WHERE rr.id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async resolveDepartmentId(name) {
      return findMasterIdByName("departments", name);
    },

    async resolveProblemId(name) {
      return findMasterIdByName("problems", name);
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
