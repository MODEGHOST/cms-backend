import { parsePagination, paginatedJson } from "../validators/common.js";

const MASTER_CONFIG = {
  companies: {
    table: "companies",
    searchable: ["name", "name_en"],
    fields: ["id", "name", "name_en", "is_active", "created_at", "updated_at"],
  },
  departments: {
    table: "departments",
    searchable: ["name"],
    fields: ["id", "name", "is_active", "created_at", "updated_at"],
  },
  machines: {
    table: "machines",
    searchable: ["name"],
    fields: ["id", "name", "is_active", "created_at", "updated_at"],
  },
  problems: {
    table: "problems",
    searchable: ["name", "name_en"],
    fields: ["id", "name", "name_en", "is_active", "created_at", "updated_at"],
  },
  shifts: {
    table: "shifts",
    searchable: ["name"],
    fields: ["id", "name", "is_active", "created_at", "updated_at"],
  },
};

function activeFilter(query, params, { activeOnly }) {
  if (activeOnly) {
    query.push("is_active = 1");
  } else if (params.is_active === "1" || params.is_active === "0") {
    query.push("is_active = ?");
    return [Number(params.is_active)];
  }
  return [];
}

export function createMasterRepository(pool) {
  function getConfig(key) {
    const cfg = MASTER_CONFIG[key];
    if (!cfg) throw Object.assign(new Error(`Unknown master: ${key}`), { status: 400 });
    return cfg;
  }

  return {
    async listSimple(key, params = {}) {
      const cfg = getConfig(key);
      const { page, pageSize, offset } = parsePagination(params, { maxPageSize: 5000 });
      const where = [];
      const values = [];

      const q = String(params.q || "").trim();
      if (q) {
        where.push(`(${cfg.searchable.map((col) => `${col} LIKE ?`).join(" OR ")})`);
        for (let i = 0; i < cfg.searchable.length; i += 1) values.push(`%${q}%`);
      }

      values.push(...activeFilter(where, params, { activeOnly: params.activeOnly === "1" }));

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM ${cfg.table} ${whereSql}`,
        values,
      );
      const [rows] = await pool.query(
        `SELECT ${cfg.fields.join(", ")}
         FROM ${cfg.table}
         ${whereSql}
         ORDER BY name ASC
         LIMIT ? OFFSET ?`,
        [...values, pageSize, offset],
      );

      return paginatedJson(rows, Number(total), { page, pageSize });
    },

    async createSimple(key, { name, name_en = null, is_active = 1 }) {
      const cfg = getConfig(key);
      const hasNameEn = cfg.fields.includes("name_en");
      if (hasNameEn) {
        const [result] = await pool.query(
          `INSERT INTO ${cfg.table} (name, name_en, is_active) VALUES (?, ?, ?)`,
          [
            String(name).trim(),
            name_en == null || String(name_en).trim() === ""
              ? null
              : String(name_en).trim(),
            is_active ? 1 : 0,
          ],
        );
        return result.insertId;
      }
      const [result] = await pool.query(
        `INSERT INTO ${cfg.table} (name, is_active) VALUES (?, ?)`,
        [String(name).trim(), is_active ? 1 : 0],
      );
      return result.insertId;
    },

    async updateSimple(key, id, { name, name_en, is_active }) {
      const cfg = getConfig(key);
      const fields = [];
      const values = [];
      if (name != null) {
        fields.push("name = ?");
        values.push(String(name).trim());
      }
      if (cfg.fields.includes("name_en") && name_en !== undefined) {
        fields.push("name_en = ?");
        values.push(
          name_en == null || String(name_en).trim() === ""
            ? null
            : String(name_en).trim(),
        );
      }
      if (is_active != null) {
        fields.push("is_active = ?");
        values.push(is_active ? 1 : 0);
      }
      if (!fields.length) return false;
      values.push(id);
      const [result] = await pool.query(
        `UPDATE ${cfg.table} SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
      return result.affectedRows > 0;
    },

    async listCustomerAliases(params = {}) {
      const { page, pageSize, offset } = parsePagination(params, { maxPageSize: 5000 });
      const where = [];
      const values = [];

      const q = String(params.q || "").trim();
      if (q) {
        where.push("(ca.name LIKE ? OR c.name LIKE ?)");
        values.push(`%${q}%`, `%${q}%`);
      }
      if (params.company_id) {
        where.push("ca.company_id = ?");
        values.push(Number(params.company_id));
      }
      if (params.activeOnly === "1") {
        where.push("ca.is_active = 1");
      } else if (params.is_active === "1" || params.is_active === "0") {
        where.push("ca.is_active = ?");
        values.push(Number(params.is_active));
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total
         FROM customer_aliases ca
         INNER JOIN companies c ON c.id = ca.company_id
         ${whereSql}`,
        values,
      );
      const [rows] = await pool.query(
        `SELECT ca.id, ca.company_id, ca.name, ca.is_active, ca.created_at, ca.updated_at,
                c.name AS company_name
         FROM customer_aliases ca
         INNER JOIN companies c ON c.id = ca.company_id
         ${whereSql}
         ORDER BY c.name ASC, ca.name ASC
         LIMIT ? OFFSET ?`,
        [...values, pageSize, offset],
      );
      return paginatedJson(rows, Number(total), { page, pageSize });
    },

    async createCustomerAlias({ company_id, name, is_active = 1 }) {
      const [result] = await pool.query(
        `INSERT INTO customer_aliases (company_id, name, is_active)
         VALUES (?, ?, ?)`,
        [Number(company_id), String(name).trim(), is_active ? 1 : 0],
      );
      return result.insertId;
    },

    async updateCustomerAlias(id, { company_id, name, is_active }) {
      const fields = [];
      const values = [];
      if (company_id != null) {
        fields.push("company_id = ?");
        values.push(Number(company_id));
      }
      if (name != null) {
        fields.push("name = ?");
        values.push(String(name).trim());
      }
      if (is_active != null) {
        fields.push("is_active = ?");
        values.push(is_active ? 1 : 0);
      }
      if (!fields.length) return false;
      values.push(id);
      const [result] = await pool.query(
        `UPDATE customer_aliases SET ${fields.join(", ")} WHERE id = ?`,
        values,
      );
      return result.affectedRows > 0;
    },

    async listAliasNamesByCompanyId(companyId) {
      const [rows] = await pool.query(
        `SELECT name FROM customer_aliases
         WHERE company_id = ? AND is_active = 1
         ORDER BY name ASC`,
        [Number(companyId)],
      );
      return rows.map((row) => row.name);
    },

    /** Insert missing nicknames for a company; does not delete existing ones. */
    async ensureAliases(companyId, names = []) {
      const cleaned = [
        ...new Set(
          (Array.isArray(names) ? names : [])
            .map((name) => String(name || "").trim())
            .filter(Boolean),
        ),
      ];
      for (const name of cleaned) {
        const [existing] = await pool.query(
          `SELECT id FROM customer_aliases
           WHERE company_id = ? AND name = ?
           LIMIT 1`,
          [Number(companyId), name],
        );
        if (existing.length) {
          await pool.query(
            `UPDATE customer_aliases SET is_active = 1 WHERE id = ?`,
            [existing[0].id],
          );
          continue;
        }
        await pool.query(
          `INSERT INTO customer_aliases (company_id, name, is_active)
           VALUES (?, ?, 1)`,
          [Number(companyId), name],
        );
      }
      return cleaned;
    },

    async findById(key, id) {
      if (key === "customer-aliases") {
        const [rows] = await pool.query(
          `SELECT ca.id, ca.company_id, ca.name, ca.is_active, ca.created_at, ca.updated_at,
                  c.name AS company_name
           FROM customer_aliases ca
           INNER JOIN companies c ON c.id = ca.company_id
           WHERE ca.id = ?
           LIMIT 1`,
          [id],
        );
        return rows[0] || null;
      }
      const cfg = getConfig(key);
      const [rows] = await pool.query(
        `SELECT ${cfg.fields.join(", ")} FROM ${cfg.table} WHERE id = ? LIMIT 1`,
        [id],
      );
      const row = rows[0] || null;
      if (!row || key !== "companies") return row;
      const [aliasRows] = await pool.query(
        `SELECT name FROM customer_aliases
         WHERE company_id = ? AND is_active = 1
         ORDER BY name ASC`,
        [id],
      );
      return { ...row, aliases: aliasRows.map((item) => item.name) };
    },
  };
}
