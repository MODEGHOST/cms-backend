import { httpError } from "../core/http-error.js";
import { createMasterRepository } from "../repositories/masters.js";
import { enrichProblemRow } from "../utils/problem-image.js";

const SIMPLE_KEYS = new Set(["companies", "departments", "machines", "problems", "shifts"]);

export function createMasterService(pool) {
  const repo = createMasterRepository(pool);

  return {
    async list(key, query) {
      if (key === "customer-aliases") {
        return repo.listCustomerAliases(query);
      }
      if (!SIMPLE_KEYS.has(key)) throw httpError(404, "Master not found");
      const result = await repo.listSimple(key, query);
      if (key === "problems") {
        return { ...result, data: (result.data || []).map(enrichProblemRow) };
      }
      return result;
    },

    async create(key, body) {
      if (key === "customer-aliases") {
        if (!body?.company_id || !String(body?.name || "").trim()) {
          throw httpError(400, "company_id and name are required");
        }
        try {
          const id = await repo.createCustomerAlias(body);
          return repo.findById(key, id);
        } catch (err) {
          if (err?.code === "ER_DUP_ENTRY") throw httpError(409, "Name already exists");
          throw err;
        }
      }
      if (!SIMPLE_KEYS.has(key)) throw httpError(404, "Master not found");
      if (!String(body?.name || "").trim()) throw httpError(400, "name is required");
      try {
        const id = await repo.createSimple(key, body);
        if (key === "companies" && body?.aliases != null) {
          await repo.ensureAliases(id, body.aliases);
        }
        const row = await repo.findById(key, id);
        return key === "problems" ? enrichProblemRow(row) : row;
      } catch (err) {
        if (err?.code === "ER_DUP_ENTRY") throw httpError(409, "Name already exists");
        throw err;
      }
    },

    async update(key, id, body) {
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) throw httpError(400, "Invalid id");

      if (key === "customer-aliases") {
        try {
          const ok = await repo.updateCustomerAlias(numericId, body);
          if (!ok) throw httpError(404, "Not found");
          const row = await repo.findById(key, numericId);
          return key === "problems" ? enrichProblemRow(row) : row;
        } catch (err) {
          if (err?.status) throw err;
          if (err?.code === "ER_DUP_ENTRY") throw httpError(409, "Name already exists");
          throw err;
        }
      }
      if (!SIMPLE_KEYS.has(key)) throw httpError(404, "Master not found");
      try {
        const ok = await repo.updateSimple(key, numericId, body);
        if (!ok) throw httpError(404, "Not found");
        if (key === "companies" && body?.aliases != null) {
          await repo.ensureAliases(numericId, body.aliases);
        }
        const row = await repo.findById(key, numericId);
        return key === "problems" ? enrichProblemRow(row) : row;
      } catch (err) {
        if (err?.status) throw err;
        if (err?.code === "ER_DUP_ENTRY") throw httpError(409, "Name already exists");
        throw err;
      }
    },
  };
}
