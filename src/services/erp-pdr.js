import { logger } from "../core/logger.js";
import { getErpDevFixture } from "./erp-dev-fixtures.js";
import { normalizeErpPdrRow } from "../utils/derive-small-sheet-price.js";

/**
 * Soft client for Beta_api_erp — read-only, pdr_no only, short timeout.
 * Never throws to callers; returns { enabled, ok, data, error }.
 */
export function createErpPdrClient({ config }) {
  const erp = config.erp || {};

  async function getByPdrNo(pdrNo) {
    const trimmed = String(pdrNo || "").trim();
    if (!erp.enabled || !erp.baseUrl) {
      return { enabled: false, ok: true, data: [], error: null };
    }
    if (!trimmed) {
      return {
        enabled: true,
        ok: false,
        data: [],
        error: "ต้องระบุ pdr_no",
      };
    }

    if (erp.devFixture) {
      const fixture = getErpDevFixture(trimmed);
      if (fixture) {
        logger.info("erp_pdr_dev_fixture", { pdr_no: trimmed });
        return {
          enabled: true,
          ok: true,
          data: [normalizeErpPdrRow(fixture)],
          error: null,
        };
      }
    }

    // baseUrl may include path (e.g. http://127.0.0.1:90/lfb_cms/erp)
    // Use relative join — NOT "/api/pdr" which replaces the whole path.
    const base = String(erp.baseUrl).replace(/\/?$/, "/");
    const url = new URL("api/pdr", base);
    url.searchParams.set("pdr_no", trimmed);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), erp.timeoutMs || 5000);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error || body?.message || `ERP HTTP ${response.status}`;
        logger.warn("erp_pdr_http_error", { pdr_no: trimmed, status: response.status, message });
        return { enabled: true, ok: false, data: [], error: message };
      }
      return {
        enabled: true,
        ok: true,
        data: (Array.isArray(body?.data) ? body.data : []).map(normalizeErpPdrRow),
        error: null,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "ERP timeout"
          : err?.message || "ERP unreachable";
      logger.warn("erp_pdr_fetch_failed", { pdr_no: trimmed, error: message });
      return { enabled: true, ok: false, data: [], error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  return { getByPdrNo };
}
