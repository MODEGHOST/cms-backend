import { config as appConfig } from "../core/config.js";
import { createErpPdrClient } from "../services/erp-pdr.js";

/** Proxy ไป Beta_api_erp — บังคับ pdr_no, ไม่ดึงทั้งตาราง */
export function registerErpRoutes(app, { wrap, requireAuth }) {
  const erpPdr = createErpPdrClient({ config: appConfig });

  app.get(
    "/api/erp/pdr",
    requireAuth,
    wrap(async (req, res) => {
      const pdrNo = String(req.query.pdr_no || "").trim();
      if (!pdrNo) {
        res.status(400).json({
          enabled: Boolean(appConfig.erp?.enabled && appConfig.erp?.baseUrl),
          ok: false,
          data: [],
          error: "กรุณาระบุ pdr_no",
        });
        return;
      }

      const result = await erpPdr.getByPdrNo(pdrNo);
      res.json({
        enabled: result.enabled,
        ok: result.ok,
        pdr_no: pdrNo,
        data: result.data,
        error: result.error,
      });
    }),
  );
}
