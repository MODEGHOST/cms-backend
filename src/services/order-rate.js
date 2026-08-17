import { parseIdList, parseStringList, resolveRateWindows } from "./dashboard-period.js";

/** ตัวหารแถวรวม — ครบตามที่ดึงจาก ERP */
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

function num(value) {
  return Number(value || 0);
}

function ratePct(cases, orders) {
  if (!orders) return 0;
  return Number(((cases / orders) * 100).toFixed(4));
}

function spanOf(ranges) {
  return ranges.reduce(
    (span, item) => ({
      from: item.from < span.from ? item.from : span.from,
      to: item.to > span.to ? item.to : span.to,
    }),
    { from: ranges[0].from, to: ranges[0].to },
  );
}

function splitFromRow(row, prefix) {
  return {
    pdr: num(row?.[`${prefix}_pdr`]),
    pdw: num(row?.[`${prefix}_pdw`]),
    total: num(row?.[`${prefix}_total`]),
  };
}

function withRates(cases, orders) {
  return {
    cases,
    orders,
    rate_pct: {
      pdr: ratePct(cases.pdr, orders.pdr),
      pdw: ratePct(cases.pdw, orders.pdw),
      total: ratePct(cases.total, orders.total),
    },
  };
}

function typeCaseSql(column, type) {
  return `UPPER(TRIM(${column})) LIKE '${type}%'`;
}

function bucketKey(period) {
  return `b_${String(period.from).replaceAll("-", "")}_${String(period.to).replaceAll("-", "")}`;
}

function uniqueRanges(windows) {
  const byKey = new Map();
  for (const window of windows) {
    byKey.set(`window_${window.key}`, { key: `window_${window.key}`, from: window.from, to: window.to });
    for (const period of window.periods || []) {
      addRange(byKey, period);
    }
    if (window.baseline) addRange(byKey, window.baseline);
  }
  return [...byKey.values()];
}

function addRange(byKey, period) {
  const key = bucketKey(period);
  if (!byKey.has(key)) byKey.set(key, { key, from: period.from, to: period.to });
}

/** Lower rate is better. ±10% relative change vs the previous week/month. */
function rateVerdict(latest, baseline) {
  if (baseline <= 0) return latest > 0 ? "worse" : "flat";
  const ratio = latest / baseline;
  if (ratio <= 0.9) return "improved";
  if (ratio >= 1.1) return "worse";
  return "flat";
}

function statusForSplit(latestRates, previousRates) {
  return Object.fromEntries(
    ["pdr", "pdw", "total"].map((key) => {
      const latest = Number(latestRates?.[key] || 0);
      const previous = Number(previousRates?.[key] || 0);
      return [
        key,
        {
          status: rateVerdict(latest, previous),
          delta: Number((latest - previous).toFixed(4)),
          latest,
          previous,
        },
      ];
    }),
  );
}

/**
 * Apply dashboard filters to the case numerator only.
 * The order denominator stays plant-wide (order_daily_count has no machine/dept).
 */
function buildCaseFilter(kind, alias, query = {}) {
  const clauses = [];
  const params = [];
  const addIn = (column, values) => {
    if (!values.length) return;
    clauses.push(`${alias}.${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };

  addIn("machine_id", parseIdList(query.machine_ids ?? query.machine_id));
  addIn(
    kind === "complaint" ? "responsible_department_id" : "department_id",
    parseIdList(query.department_ids ?? query.department_id),
  );
  addIn("problem_id", parseIdList(query.problem_ids ?? query.problem_id));
  addIn("company_id", parseIdList(query.company_ids ?? query.company_id));
  addIn("flute_id", parseIdList(query.flute_ids ?? query.flute_id));
  addIn("shift", parseStringList(query.shifts ?? query.shift));
  addIn("grade", parseStringList(query.grades ?? query.grade));
  addIn("job_type", parseStringList(query.job_types ?? query.job_type));

  if (kind === "complaint") {
    const statuses = parseStringList(query.statuses ?? query.status);
    if (statuses.length) {
      addIn("workflow_status", statuses);
    } else {
      clauses.push(`${alias}.workflow_status <> 'cs_draft'`);
    }
  }

  return {
    sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
    params,
  };
}

/**
 * Reject % / Complaint % vs unique prod orders in order_daily_count.
 * แถว PDR/PDW แยกเหมือนเดิม; แถวรวม = ทั้ง 9 ประเภท
 * Reads the snapshot table only — never calls ERP.
 */
export function createOrderRateService(pool) {
  async function countOrdersByRanges(ranges) {
    if (!ranges.length) return {};
    const selects = [];
    const params = [];
    for (const range of ranges) {
      selects.push(
        `SUM(odc.shipment_date BETWEEN ? AND ? AND odc.order_type = 'PDR') AS ${range.key}_pdr`,
        `SUM(odc.shipment_date BETWEEN ? AND ? AND odc.order_type = 'PDW') AS ${range.key}_pdw`,
        `SUM(odc.shipment_date BETWEEN ? AND ?) AS ${range.key}_total`,
      );
      params.push(range.from, range.to, range.from, range.to, range.from, range.to);
    }

    const span = spanOf(ranges);
    const [[row]] = await pool.query(
      `SELECT ${selects.join(", ")}
       FROM order_daily_count odc
       WHERE odc.order_type IN (${ORDER_TYPES.map(() => "?").join(", ")})
         AND odc.shipment_date BETWEEN ? AND ?`,
      [...params, ...ORDER_TYPES, span.from, span.to],
    );
    return row || {};
  }

  async function countCasesByRanges({ table, alias, dateColumn, ranges, extraSql = "", extraParams = [] }) {
    if (!ranges.length) return {};
    const selects = [];
    const params = [];
    for (const range of ranges) {
      const inRange = `${alias}.${dateColumn} BETWEEN ? AND ?`;
      selects.push(
        `SUM(${inRange} AND ${typeCaseSql(`${alias}.pdr_no`, "PDR")}) AS ${range.key}_pdr`,
        `SUM(${inRange} AND ${typeCaseSql(`${alias}.pdr_no`, "PDW")}) AS ${range.key}_pdw`,
        `SUM(${inRange}) AS ${range.key}_total`,
      );
      params.push(range.from, range.to, range.from, range.to, range.from, range.to);
    }

    const span = spanOf(ranges);
    const [[row]] = await pool.query(
      `SELECT ${selects.join(", ")}
       FROM ${table} ${alias}
       WHERE ${alias}.${dateColumn} IS NOT NULL
         AND ${alias}.${dateColumn} BETWEEN ? AND ?
         ${extraSql}`,
      [...params, span.from, span.to, ...extraParams],
    );
    return row || {};
  }

  async function lastSyncedAt() {
    const [[row]] = await pool.query(
      `SELECT MAX(synced_at) AS last_synced_at, COUNT(*) AS order_count
       FROM order_daily_count`,
    );
    return {
      last_synced_at: row?.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
      order_count: num(row?.order_count),
    };
  }

  async function buildComparison({ kind, table, alias, dateColumn, query = {} }) {
    const windows = resolveRateWindows();
    const ranges = uniqueRanges(windows);
    const caseFilter = buildCaseFilter(kind, alias, query);
    const [orderRow, caseRow, meta] = await Promise.all([
      countOrdersByRanges(ranges),
      countCasesByRanges({
        table,
        alias,
        dateColumn,
        ranges,
        extraSql: caseFilter.sql,
        extraParams: caseFilter.params,
      }),
      lastSyncedAt(),
    ]);

    return {
      kind,
      source: "order_daily_count",
      date_column: dateColumn,
      last_synced_at: meta.last_synced_at,
      order_count: meta.order_count,
      case_filters_applied: Boolean(caseFilter.sql),
      denominator_note: "เทียบกับใบสั่งทั้งโรงงาน (9 ประเภท) ตามวันตีบิล · จำนวนครั้งตามตัวกรองหน้า",
      windows: windows.map((window) => {
        const totals = withRates(
          splitFromRow(caseRow, `window_${window.key}`),
          splitFromRow(orderRow, `window_${window.key}`),
        );
        const periods = (window.periods || []).map((period) => {
          const key = bucketKey(period);
          return {
            key: period.key,
            label: period.label,
            short_label: period.short_label,
            from: period.from,
            to: period.to,
            current: period.current,
            ...withRates(splitFromRow(caseRow, key), splitFromRow(orderRow, key)),
          };
        });
        const latest = periods.find((item) => item.current) || periods[periods.length - 1];
        const baselinePeriod = window.baseline
          ? {
              key: window.baseline.key,
              label: window.baseline.label,
              short_label: window.baseline.short_label,
              from: window.baseline.from,
              to: window.baseline.to,
              ...withRates(
                splitFromRow(caseRow, bucketKey(window.baseline)),
                splitFromRow(orderRow, bucketKey(window.baseline)),
              ),
            }
          : null;
        return {
          key: window.key,
          label: window.label,
          grain: window.grain,
          compare_grain: window.compare_grain || window.grain,
          from: window.from,
          to: window.to,
          ...totals,
          periods,
          baseline: baselinePeriod,
          status: statusForSplit(latest?.rate_pct, baselinePeriod?.rate_pct),
        };
      }),
    };
  }

  return {
    getRejectOrderRate(query = {}) {
      return buildComparison({
        kind: "reject",
        table: "reject_records",
        alias: "rr",
        dateColumn: "reject_received_date",
        query,
      });
    },

    getComplaintOrderRate(query = {}) {
      return buildComparison({
        kind: "complaint",
        table: "complaint_records",
        alias: "cr",
        dateColumn: "received_date",
        query,
      });
    },
  };
}
