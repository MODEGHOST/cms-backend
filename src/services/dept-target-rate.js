import {
  buildComparisonPeriods,
  describeWeekByFrom,
  monthWindow,
  weekWindow,
} from "./dashboard-period.js";

/** Plant-wide order types — same denominator as OrderRateComparisonTable. */
const ORDER_TYPES = [
  "PDC",
  "PDD",
  "PDF",
  "PDO",
  "PDP",
  "PDR",
  "PDS",
  "PDW",
  "PDZ",
];

/**
 * Fixed comparison rows matching the Weekly vs Monthly % Reject sheet.
 * department_names map to master `departments.name` (canonical codes).
 * Sale support has no separate master yet — stays 0 until mapped.
 */
export const DEPT_TARGET_ROWS = [
  {
    key: "raw_materials",
    related: "Raw Materials",
    responsible: "IQC + Procurement",
    issue: "ปัญหาที่เกิดจากวัตถุดิบ (ม้วน)",
    target_pct: 0.05,
    department_names: ["IQC", "PU", "RM"],
  },
  {
    key: "process_quality",
    related: "Process + Quality",
    responsible: "PD + QC",
    issue: "ปัญหาคุณภาพที่เกิดจาก Production",
    target_pct: 0.3,
    department_names: ["PD", "QC"],
  },
  {
    key: "fg_warehouse",
    related: "คลังFG",
    responsible: "VA",
    issue: "ปัญหาที่เกิดจากกระบวนการทำ VA",
    target_pct: 0,
    department_names: ["FG"],
  },
  {
    key: "planning",
    related: "วางแผน",
    responsible: "Planning",
    issue: "ปัญหาวางแผนผิด",
    target_pct: 0,
    department_names: ["PLAN"],
  },
  {
    key: "marketing_cs",
    related: "Marketing",
    responsible: "CS, Admin, Sale",
    issue: "ปัญหาเปิดงานผิด",
    target_pct: 0,
    department_names: ["MKT", "SALE"],
  },
  {
    key: "marketing_ss",
    related: "Marketing",
    responsible: "Sale support",
    issue: "ปัญหาไม่เคลียร์ ระหว่างโรงงานกับลูกค้า",
    target_pct: 0.1,
    department_names: [],
  },
  {
    key: "delivery",
    related: "Delivery",
    responsible: "LTS",
    issue: "รอยหัก + บุบบุบ + กระแทก + เปียกน้ำ",
    target_pct: 0,
    department_names: ["LTS"],
  },
];

function num(value) {
  return Number(value || 0);
}

function ratePct(cases, orders) {
  if (!orders) return 0;
  return Number(((cases / orders) * 100).toFixed(4));
}

function avg(values) {
  if (!values.length) return 0;
  const sum = values.reduce((acc, value) => acc + Number(value || 0), 0);
  return Number((sum / values.length).toFixed(4));
}

function statusFor(avgPct, targetPct) {
  const onTarget = avgPct <= targetPct + 1e-12;
  return {
    status: onTarget ? "on_target" : "exceed",
    label: onTarget ? "ตามเป้า" : "เกิน Target",
  };
}

/**
 * % Reject / % Complaint by responsible-department group vs NEW TARGET.
 * Formula: cases ÷ plant-wide order_daily_count (same as order-rate table).
 * Columns: 4 rolling periods ending at today (grain = week | month).
 */
export function createDeptTargetRateService(pool) {
  async function loadDepartmentMap() {
    const [rows] = await pool.query(
      `SELECT id, name FROM departments WHERE is_active = 1`,
    );
    const byName = new Map();
    for (const row of rows) {
      byName.set(String(row.name || "").trim().toUpperCase(), Number(row.id));
    }
    return byName;
  }

  async function loadTargetOverrides(kind) {
    const [rows] = await pool.query(
      `SELECT row_key, target_pct
       FROM dept_target_settings
       WHERE kind = ?`,
      [kind],
    );
    const map = new Map();
    for (const row of rows || []) {
      map.set(String(row.row_key), Number(row.target_pct));
    }
    return map;
  }

  function resolveTargetPct(def, overrides) {
    if (overrides.has(def.key)) {
      return Number(overrides.get(def.key) || 0);
    }
    return Number(def.target_pct || 0);
  }

  /**
   * Persist Target % for each department row.
   * Body: { targets: [{ key, target_pct }, ...] }
   */
  async function updateTargets(kind, body = {}) {
    const safeKind = kind === "complaint" ? "complaint" : "reject";
    const allowed = new Set(DEPT_TARGET_ROWS.map((row) => row.key));
    const raw = Array.isArray(body.targets) ? body.targets : [];
    if (!raw.length) {
      const err = new Error("ต้องส่ง targets อย่างน้อย 1 รายการ");
      err.status = 400;
      throw err;
    }

    const updates = [];
    for (const item of raw) {
      const key = String(item?.key || "").trim();
      if (!allowed.has(key)) {
        const err = new Error(`ไม่รู้จักแถว Target: ${key}`);
        err.status = 400;
        throw err;
      }
      const value = Number(item?.target_pct);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        const err = new Error(`Target ของ ${key} ต้องเป็นตัวเลขระหว่าง 0–100`);
        err.status = 400;
        throw err;
      }
      updates.push({
        key,
        target_pct: Number(value.toFixed(4)),
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const item of updates) {
        await conn.query(
          `INSERT INTO dept_target_settings (kind, row_key, target_pct)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE target_pct = VALUES(target_pct)`,
          [safeKind, item.key, item.target_pct],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return {
      kind: safeKind,
      targets: updates,
    };
  }

  async function countOrdersByPeriods(periods) {
    if (!periods.length) return {};
    const selects = [];
    const params = [];
    for (const period of periods) {
      selects.push(
        `SUM(odc.shipment_date BETWEEN ? AND ?) AS ${period.key}`,
      );
      params.push(period.from, period.to);
    }
    const spanFrom = periods[0].from;
    const spanTo = periods[periods.length - 1].to;
    const [[row]] = await pool.query(
      `SELECT ${selects.join(", ")}
       FROM order_daily_count odc
       WHERE odc.order_type IN (${ORDER_TYPES.map(() => "?").join(", ")})
         AND odc.shipment_date BETWEEN ? AND ?`,
      [...params, ...ORDER_TYPES, spanFrom, spanTo],
    );
    return row || {};
  }

  async function countCasesByDeptPeriods({
    table,
    alias,
    dateColumn,
    deptColumn,
    periods,
    extraSql = "",
    extraParams = [],
  }) {
    if (!periods.length) return [];
    const selects = [`${alias}.${deptColumn} AS department_id`];
    const params = [];
    for (const period of periods) {
      selects.push(
        `SUM(${alias}.${dateColumn} BETWEEN ? AND ?) AS ${period.key}`,
      );
      params.push(period.from, period.to);
    }
    const spanFrom = periods[0].from;
    const spanTo = periods[periods.length - 1].to;
    const [rows] = await pool.query(
      `SELECT ${selects.join(", ")}
       FROM ${table} ${alias}
       WHERE ${alias}.${dateColumn} IS NOT NULL
         AND ${alias}.${dateColumn} BETWEEN ? AND ?
         AND ${alias}.${deptColumn} IS NOT NULL
         ${extraSql}
       GROUP BY ${alias}.${deptColumn}`,
      [...params, spanFrom, spanTo, ...extraParams],
    );
    return rows || [];
  }

  function resolvePeriods(query = {}, now = new Date()) {
    const grain = String(query.grain || "week").toLowerCase() === "month" ? "month" : "week";
    const count = 4;
    const range = grain === "month" ? monthWindow(now, count) : weekWindow(now, count);
    const built = buildComparisonPeriods(range, grain, count - 1);
    const periods = built.map((period, index) => {
      const meta = grain === "week" ? describeWeekByFrom(period.from) : null;
      return {
        key: `${grain}_${index + 1}`,
        slot: index + 1,
        from: period.from,
        to: period.to,
        label: period.label,
        // Same labels as OrderRateComparisonTable: W.33 / M.8
        short_label: period.short_label,
        week_of_month: meta?.week_of_month ?? null,
        month:
          meta?.month ??
          (grain === "month" ? Number(String(period.from).slice(5, 7)) : null),
        year: meta?.year ?? Number(String(period.from).slice(0, 4)),
        month_key: meta?.month_key || String(period.from).slice(0, 7),
        current: Boolean(period.current),
      };
    });
    return { grain, count, from: range.from, to: range.to, periods };
  }

  async function lastSyncedAt() {
    const [[row]] = await pool.query(
      `SELECT MAX(synced_at) AS last_synced_at, COUNT(*) AS order_count
       FROM order_daily_count`,
    );
    return {
      last_synced_at: row?.last_synced_at
        ? new Date(row.last_synced_at).toISOString()
        : null,
      order_count: num(row?.order_count),
    };
  }

  async function build({ kind, table, alias, dateColumn, deptColumn, query = {} }) {
    const window = resolvePeriods(query);
    const periods = window.periods;
    const complaintExtra =
      kind === "complaint" ? `AND ${alias}.workflow_status <> 'cs_draft'` : "";

    const [deptByName, orderRow, caseRows, meta, targetOverrides] =
      await Promise.all([
        loadDepartmentMap(),
        countOrdersByPeriods(periods),
        countCasesByDeptPeriods({
          table,
          alias,
          dateColumn,
          deptColumn,
          periods,
          extraSql: complaintExtra,
        }),
        lastSyncedAt(),
        loadTargetOverrides(kind),
      ]);

    const casesByDept = new Map();
    for (const row of caseRows) {
      casesByDept.set(Number(row.department_id), row);
    }

    const ordersByPeriod = Object.fromEntries(
      periods.map((period) => [period.key, num(orderRow[period.key])]),
    );

    const rows = DEPT_TARGET_ROWS.map((def) => {
      const deptIds = def.department_names
        .map((name) => deptByName.get(String(name).toUpperCase()))
        .filter((id) => Number.isFinite(id));

      const periodValues = periods.map((period) => {
        let cases = 0;
        for (const id of deptIds) {
          cases += num(casesByDept.get(id)?.[period.key]);
        }
        const orders = ordersByPeriod[period.key] || 0;
        return {
          key: period.key,
          cases,
          orders,
          rate_pct: ratePct(cases, orders),
        };
      });

      const monthlyAvg = avg(periodValues.map((item) => item.rate_pct));
      const target = resolveTargetPct(def, targetOverrides);
      const variance = Number((monthlyAvg - target).toFixed(4));
      const status = statusFor(monthlyAvg, target);

      return {
        key: def.key,
        related: def.related,
        responsible: def.responsible,
        issue: def.issue,
        target_pct: target,
        department_names: def.department_names,
        department_ids: deptIds,
        periods: periodValues,
        weeks: periodValues,
        monthly_avg_pct: monthlyAvg,
        variance_pct: variance,
        ...status,
      };
    });

    const totalPeriodValues = periods.map((period, index) => {
      const cases = rows.reduce((sum, row) => sum + num(row.periods[index]?.cases), 0);
      const orders = ordersByPeriod[period.key] || 0;
      return {
        key: period.key,
        cases,
        orders,
        rate_pct: ratePct(cases, orders),
      };
    });
    const totalTarget = Number(
      rows.reduce((sum, row) => sum + Number(row.target_pct || 0), 0).toFixed(4),
    );
    const totalAvg = avg(totalPeriodValues.map((item) => item.rate_pct));
    const totalVariance = Number((totalAvg - totalTarget).toFixed(4));
    const totalStatus = statusFor(totalAvg, totalTarget);
    const avgLabel = window.grain === "month" ? "เฉลี่ย 4 เดือน" : "เฉลี่ย 4 สัปดาห์";

    return {
      kind,
      grain: window.grain,
      source: "order_daily_count",
      date_column: dateColumn,
      department_column: deptColumn,
      formula: "จำนวนครั้ง ÷ จำนวนใบสั่งทั้งโรงงาน (9 ประเภท) ตามวันตีบิล",
      denominator_note:
        "ตัวหารเดียวกับตารางเทียบ % · นับใบสั่งทั้งโรงงานตามช่วง · ไม่แยกหน่วยงาน",
      avg_label: avgLabel,
      last_synced_at: meta.last_synced_at,
      order_count: meta.order_count,
      from: window.from,
      to: window.to,
      periods: periods.map((period) => ({
        ...period,
        orders: ordersByPeriod[period.key] || 0,
      })),
      weeks: periods.map((period) => ({
        ...period,
        orders: ordersByPeriod[period.key] || 0,
      })),
      rows,
      total: {
        key: "total",
        related: `รวม % ${kind === "complaint" ? "COMPLAINT" : "REJECT"}`,
        responsible: "",
        issue: "",
        target_pct: totalTarget,
        periods: totalPeriodValues,
        weeks: totalPeriodValues,
        monthly_avg_pct: totalAvg,
        variance_pct: totalVariance,
        ...totalStatus,
        label: totalStatus.status === "on_target" ? "ตามเป้า" : "เกินเป้าหมาย",
      },
    };
  }

  return {
    getRejectDeptTargetRate(query = {}) {
      return build({
        kind: "reject",
        table: "reject_records",
        alias: "rr",
        dateColumn: "reject_received_date",
        deptColumn: "department_id",
        query,
      });
    },

    getComplaintDeptTargetRate(query = {}) {
      return build({
        kind: "complaint",
        table: "complaint_records",
        alias: "cr",
        dateColumn: "received_date",
        deptColumn: "responsible_department_id",
        query,
      });
    },

    updateRejectTargets(body = {}) {
      return updateTargets("reject", body);
    },

    updateComplaintTargets(body = {}) {
      return updateTargets("complaint", body);
    },
  };
}
