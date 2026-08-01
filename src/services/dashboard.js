import {
  anchorNotInFuture,
  bucketSql,
  buildComparisonPeriods,
  comparisonGrain,
  normalizeDate,
  parseIdList,
  parseStringList,
  resolveDateRange,
  resolveTrendGrain,
} from "./dashboard-period.js";

/** Column that absorbs rejects with no machine, or a machine removed from Master. */
const MACHINE_OTHER_KEY = "machine_other";

/** How many buckets the machine comparison table may show, per grain. */
const MACHINE_COMPARISON_BUCKETS = {
  day: { options: [7, 14, 30], default: 7 },
  week: { options: [4, 8, 12], default: 4 },
  month: { options: [3, 6, 12], default: 6 },
};

/**
 * Dashboard aggregations — all filtering happens in SQL on the backend.
 */
export function createDashboardService(pool) {
  /** SQL expression that buckets reject_received_date for the trend chart. */
  function trendBucketSql(grain) {
    return bucketSql(grain, "rr.reject_received_date");
  }

  function resolveMachineComparisonBuckets(value, grain) {
    const config = MACHINE_COMPARISON_BUCKETS[grain] || MACHINE_COMPARISON_BUCKETS.day;
    const requested = Number(value);
    return {
      count: config.options.includes(requested) ? requested : config.default,
      options: config.options,
    };
  }

  function buildWhere({ from, to, machineIds = [], departmentIds = [], shifts = [], jobTypes = [] }) {
    const { clauses, params } = buildRecordFilters({
      from,
      to,
      machineIds,
      departmentIds,
      shifts,
      jobTypes,
    });
    return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
  }

  function buildRecordFilters({
    from,
    to,
    machineIds = [],
    departmentIds = [],
    shifts = [],
    jobTypes = [],
  }) {
    const clauses = ["rr.reject_received_date IS NOT NULL", "rr.reject_received_date BETWEEN ? AND ?"];
    const params = [from, to];

    if (machineIds.length === 1) {
      clauses.push("rr.machine_id = ?");
      params.push(machineIds[0]);
    } else if (machineIds.length > 1) {
      clauses.push(`rr.machine_id IN (${machineIds.map(() => "?").join(", ")})`);
      params.push(...machineIds);
    }

    if (departmentIds.length === 1) {
      clauses.push("rr.department_id = ?");
      params.push(departmentIds[0]);
    } else if (departmentIds.length > 1) {
      clauses.push(`rr.department_id IN (${departmentIds.map(() => "?").join(", ")})`);
      params.push(...departmentIds);
    }

    if (shifts.length === 1) {
      clauses.push("rr.shift = ?");
      params.push(shifts[0]);
    } else if (shifts.length > 1) {
      clauses.push(`rr.shift IN (${shifts.map(() => "?").join(", ")})`);
      params.push(...shifts);
    }

    if (jobTypes.length === 1) {
      clauses.push("rr.job_type = ?");
      params.push(jobTypes[0]);
    } else if (jobTypes.length > 1) {
      clauses.push(`rr.job_type IN (${jobTypes.map(() => "?").join(", ")})`);
      params.push(...jobTypes);
    }

    return { clauses, params };
  }

  function resolveFilterIds(query = {}) {
    const machineIds = parseIdList(query.machine_ids ?? query.machine_id);
    const departmentIds = parseIdList(query.department_ids ?? query.department_id);
    const shifts = parseStringList(query.shifts ?? query.shift);
    const jobTypes = parseStringList(query.job_types ?? query.job_type);
    return { machineIds, departmentIds, shifts, jobTypes };
  }

  async function fetchDayDetail(query = {}) {
    const date = normalizeDate(query.date);
    if (!date) {
      const err = new Error("ต้องระบุ date (YYYY-MM-DD)");
      err.status = 400;
      throw err;
    }

    const filterIds = resolveFilterIds(query);
    const { whereSql, params } = buildWhere({ from: date, to: date, ...filterIds });

    const [[kpi]] = await pool.query(
      `SELECT COUNT(*) AS total_count
       FROM reject_records rr
       ${whereSql}`,
      params,
    );

    const [departments] = await pool.query(
      `SELECT d.id, d.name, COUNT(*) AS count
       FROM reject_records rr
       INNER JOIN departments d ON d.id = rr.department_id
       ${whereSql}
       GROUP BY d.id, d.name
       ORDER BY count DESC, d.name ASC`,
      params,
    );

    const [machines] = await pool.query(
      `SELECT m.id, m.name, COUNT(*) AS count
       FROM reject_records rr
       INNER JOIN machines m ON m.id = rr.machine_id
       ${whereSql}
       GROUP BY m.id, m.name
       ORDER BY count DESC, m.name ASC`,
      params,
    );

    const [problems] = await pool.query(
      `SELECT p.id, p.name, COUNT(*) AS count
       FROM reject_records rr
       INNER JOIN problems p ON p.id = rr.problem_id
       ${whereSql}
       GROUP BY p.id, p.name
       ORDER BY count DESC, p.name ASC`,
      params,
    );

    const [items] = await pool.query(
      `SELECT
         rr.id,
         d.name AS department_name,
         m.name AS machine_name,
         p.name AS problem_name,
         c.name AS company_name,
         rr.cause,
         rr.invoice_no
       FROM reject_records rr
       LEFT JOIN departments d ON d.id = rr.department_id
       LEFT JOIN machines m ON m.id = rr.machine_id
       LEFT JOIN problems p ON p.id = rr.problem_id
       LEFT JOIN companies c ON c.id = rr.company_id
       ${whereSql}
       ORDER BY d.name ASC, m.name ASC, p.name ASC, rr.id ASC`,
      params,
    );

    const toCountList = (rows) =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count),
      }));

    return {
      date,
      machine_id: filterIds.machineIds[0] || null,
      machine_ids: filterIds.machineIds,
      department_ids: filterIds.departmentIds,
      shifts: filterIds.shifts,
      job_types: filterIds.jobTypes,
      total_count: Number(kpi.total_count || 0),
      departments: toCountList(departments),
      machines: toCountList(machines),
      problems: toCountList(problems),
      items: items.map((row) => ({
        id: row.id,
        department_name: row.department_name || "—",
        machine_name: row.machine_name || "—",
        problem_name: row.problem_name || "—",
        company_name: row.company_name || "—",
        cause: row.cause || null,
        invoice_no: row.invoice_no || null,
      })),
    };
  }

  /** Narrow period=all to the actual reject data span (same rows, cheaper scans). */
  async function resolveEffectiveRange(query = {}) {
    const range = resolveDateRange(query);
    if (range.period !== "all") return range;
    const [[row]] = await pool.query(
      `SELECT MIN(reject_received_date) AS min_date, MAX(reject_received_date) AS max_date
       FROM reject_records
       WHERE reject_received_date IS NOT NULL`,
    );
    return {
      period: "all",
      from: normalizeDate(row?.min_date) || range.from,
      to: normalizeDate(row?.max_date) || range.to,
    };
  }

  async function buildRejectTrendPayload(range, filterIds, trendGrain) {
    const { whereSql, params } = buildWhere({ ...range, ...filterIds });
    const bucketExpr = trendBucketSql(trendGrain);

    const [[trend], [trendByMachine], [trendByDepartment], [trendByProblem]] = await Promise.all([
      pool.query(
        `SELECT ${bucketExpr} AS date, COUNT(*) AS count
         FROM reject_records rr
         ${whereSql}
         GROUP BY ${bucketExpr}
         ORDER BY date ASC`,
        params,
      ),
      pool.query(
        `SELECT
           ${bucketExpr} AS date,
           COALESCE(m.name, 'ไม่ระบุเครื่อง') AS name,
           COUNT(*) AS count
         FROM reject_records rr
         LEFT JOIN machines m ON m.id = rr.machine_id
         ${whereSql}
         GROUP BY ${bucketExpr}, m.id, m.name
         ORDER BY date ASC, count DESC`,
        params,
      ),
      pool.query(
        `SELECT
           ${bucketExpr} AS date,
           COALESCE(d.name, 'ไม่ระบุหน่วยงาน') AS name,
           COUNT(*) AS count
         FROM reject_records rr
         LEFT JOIN departments d ON d.id = rr.department_id
         ${whereSql}
         GROUP BY ${bucketExpr}, d.id, d.name
         ORDER BY date ASC, count DESC`,
        params,
      ),
      pool.query(
        `SELECT
           ${bucketExpr} AS date,
           COALESCE(p.name, 'ไม่ระบุปัญหา') AS name,
           COUNT(*) AS count
         FROM reject_records rr
         LEFT JOIN problems p ON p.id = rr.problem_id
         ${whereSql}
         GROUP BY ${bucketExpr}, p.id, p.name
         ORDER BY date ASC, count DESC`,
        params,
      ),
    ]);

    const { trendRows, trendStackKeys } = buildStackedTrend({
      totals: trend,
      byMachine: trendByMachine,
      byDepartment: trendByDepartment,
      byProblem: trendByProblem,
      grain: trendGrain,
    });

    return { trend: trendRows, trendStackKeys, trendGrain };
  }

  let filterOptionsCache = null;
  let filterOptionsCachedAt = 0;
  const FILTER_OPTIONS_TTL_MS = 5 * 60 * 1000;

  return {
    /** KPI + rank charts only — no trend stacks / filter option lists. */
    async getRejectSummary(query = {}) {
      const range = await resolveEffectiveRange(query);
      const filterIds = resolveFilterIds(query);
      const { machineIds, departmentIds, shifts, jobTypes } = filterIds;
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });
      const recordFilters = buildRecordFilters({ ...range, ...filterIds });
      const joinOnSql = recordFilters.clauses.join(" AND ");
      const joinParams = recordFilters.params;

      const deptMasterWhere = ["d.is_active = 1"];
      const deptMasterParams = [...joinParams];
      if (departmentIds.length === 1) {
        deptMasterWhere.push("d.id = ?");
        deptMasterParams.push(departmentIds[0]);
      } else if (departmentIds.length > 1) {
        deptMasterWhere.push(`d.id IN (${departmentIds.map(() => "?").join(", ")})`);
        deptMasterParams.push(...departmentIds);
      }

      const [
        [[kpi]],
        [topProblems],
        [topCompanies],
        [topDepartments],
        [allProblems],
        [machines],
        [machineProblemRows],
      ] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total_count,
             COALESCE(SUM(rr.claim_sheet_qty), 0) AS total_claim_sheet_qty,
             COALESCE(SUM(rr.actual_ship_qty), 0) AS total_actual_ship_qty,
             COALESCE(SUM(
               CASE
                 WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
                 ELSE rr.claim_sheet_qty * rr.price_per_sheet
               END
             ), 0) AS total_reject_amount,
             COALESCE(SUM(
               CASE
                 WHEN rr.actual_ship_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
                 ELSE rr.actual_ship_qty * rr.price_per_sheet
               END
             ), 0) AS total_ship_amount,
             COALESCE(SUM(
               CASE
                 WHEN rr.claim_sheet_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
                 ELSE rr.claim_sheet_qty * rr.weight_per_sheet
               END
             ), 0) AS total_reject_weight,
             COALESCE(SUM(
               CASE
                 WHEN rr.actual_ship_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
                 ELSE rr.actual_ship_qty * rr.weight_per_sheet
               END
             ), 0) AS total_ship_weight,
             COALESCE(SUM(rr.claim_weight_kg), 0) AS total_claim_weight_kg,
             COUNT(DISTINCT rr.company_id) AS company_count,
             COUNT(DISTINCT rr.problem_id) AS problem_count
           FROM reject_records rr
           ${whereSql}`,
          params,
        ),
        pool.query(
          `SELECT p.id, p.name, COUNT(*) AS count
           FROM reject_records rr
           INNER JOIN problems p ON p.id = rr.problem_id
           ${whereSql}
           GROUP BY p.id, p.name
           ORDER BY count DESC
           LIMIT 5`,
          params,
        ),
        pool.query(
          `SELECT c.id, c.name, COUNT(*) AS count,
                  COALESCE(SUM(
                    CASE
                      WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
                      ELSE rr.claim_sheet_qty * rr.price_per_sheet
                    END
                  ), 0) AS reject_amount
           FROM reject_records rr
           INNER JOIN companies c ON c.id = rr.company_id
           ${whereSql}
           GROUP BY c.id, c.name
           ORDER BY count DESC
           LIMIT 5`,
          params,
        ),
        pool.query(
          `SELECT
             d.id,
             d.name,
             COUNT(rr.id) AS count,
             COALESCE(SUM(rr.claim_sheet_qty), 0) AS claim_sheet_qty,
             COALESCE(SUM(rr.actual_ship_qty), 0) AS actual_ship_qty,
             COALESCE(SUM(
               CASE
                 WHEN rr.claim_sheet_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
                 ELSE rr.claim_sheet_qty * rr.weight_per_sheet
               END
             ), 0) AS reject_weight,
             COALESCE(SUM(
               CASE
                 WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
                 ELSE rr.claim_sheet_qty * rr.price_per_sheet
               END
             ), 0) AS reject_amount
           FROM departments d
           LEFT JOIN reject_records rr
             ON rr.department_id = d.id AND ${joinOnSql}
           WHERE ${deptMasterWhere.join(" AND ")}
           GROUP BY d.id, d.name
           ORDER BY d.name ASC`,
          deptMasterParams,
        ),
        pool.query(
          `SELECT
             p.id,
             p.name,
             COUNT(rr.id) AS count,
             COALESCE(SUM(rr.claim_sheet_qty), 0) AS claim_sheet_qty,
             COALESCE(SUM(
               CASE
                 WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
                 ELSE rr.claim_sheet_qty * rr.price_per_sheet
               END
             ), 0) AS reject_amount
           FROM problems p
           LEFT JOIN reject_records rr
             ON rr.problem_id = p.id AND ${joinOnSql}
           WHERE p.is_active = 1
           GROUP BY p.id, p.name
           ORDER BY p.name ASC`,
          joinParams,
        ),
        pool.query(
          `SELECT m.id, m.name, COUNT(*) AS count
           FROM reject_records rr
           INNER JOIN machines m ON m.id = rr.machine_id
           ${whereSql}
           GROUP BY m.id, m.name
           ORDER BY count DESC`,
          params,
        ),
        pool.query(
          `SELECT
             ranked.machine_id,
             ranked.machine_name,
             ranked.problem_id,
             ranked.problem_name,
             ranked.count
           FROM (
             SELECT
               m.id AS machine_id,
               m.name AS machine_name,
               p.id AS problem_id,
               p.name AS problem_name,
               COUNT(*) AS count,
               ROW_NUMBER() OVER (
                 PARTITION BY m.id
                 ORDER BY COUNT(*) DESC, p.name ASC
               ) AS rn
             FROM reject_records rr
             INNER JOIN machines m ON m.id = rr.machine_id
             INNER JOIN problems p ON p.id = rr.problem_id
             ${whereSql}
             GROUP BY m.id, m.name, p.id, p.name
           ) ranked
           WHERE ranked.rn <= 3
           ORDER BY ranked.machine_name ASC, ranked.count DESC`,
          params,
        ),
      ]);

      const totalRejectWeight = Number(kpi.total_reject_weight || 0);
      const totalShipWeight = Number(kpi.total_ship_weight || 0);
      const totalRejectAmount = Number(kpi.total_reject_amount || 0);
      const totalShipAmount = Number(kpi.total_ship_amount || 0);
      const weightRejectPct =
        totalShipWeight > 0 ? (totalRejectWeight / totalShipWeight) * 100 : 0;
      const valueRejectPct =
        totalShipAmount > 0 ? (totalRejectAmount / totalShipAmount) * 100 : 0;

      const machinesWithTopProblemsMap = new Map();
      for (const machine of machines) {
        machinesWithTopProblemsMap.set(machine.id, {
          id: machine.id,
          name: machine.name,
          count: Number(machine.count),
          topProblems: [],
        });
      }
      for (const row of machineProblemRows) {
        const bucket = machinesWithTopProblemsMap.get(row.machine_id) || {
          id: row.machine_id,
          name: row.machine_name,
          count: 0,
          topProblems: [],
        };
        bucket.topProblems.push({
          id: row.problem_id,
          name: row.problem_name,
          count: Number(row.count),
        });
        machinesWithTopProblemsMap.set(row.machine_id, bucket);
      }
      const machinesWithTopProblems = [...machinesWithTopProblemsMap.values()];
      const machineTopProblems =
        machineIds.length === 1
          ? machinesWithTopProblems.find((item) => item.id === machineIds[0])?.topProblems || []
          : [];

      return {
        filters: {
          period: range.period,
          from: range.from,
          to: range.to,
          machine_id: machineIds[0] || null,
          machine_ids: machineIds,
          department_ids: departmentIds,
          shifts,
          job_types: jobTypes,
        },
        kpi: {
          total_count: Number(kpi.total_count || 0),
          total_claim_sheet_qty: Number(kpi.total_claim_sheet_qty || 0),
          total_actual_ship_qty: Number(kpi.total_actual_ship_qty || 0),
          total_reject_amount: totalRejectAmount,
          total_claim_amount: totalRejectAmount,
          total_ship_amount: totalShipAmount,
          total_reject_weight: totalRejectWeight,
          total_ship_weight: totalShipWeight,
          weight_reject_pct: Number(weightRejectPct.toFixed(4)),
          value_reject_pct: Number(valueRejectPct.toFixed(4)),
          total_claim_weight_kg: Number(kpi.total_claim_weight_kg || 0),
          company_count: Number(kpi.company_count || 0),
          problem_count: Number(kpi.problem_count || 0),
        },
        topProblems: topProblems.map((r) => ({ ...r, count: Number(r.count) })),
        topCompanies: topCompanies.map((r) => ({
          ...r,
          count: Number(r.count),
          reject_amount: Number(r.reject_amount),
          claim_amount: Number(r.reject_amount),
        })),
        topDepartments: topDepartments.map((r) => {
          const claimSheetQty = Number(r.claim_sheet_qty || 0);
          const actualShipQty = Number(r.actual_ship_qty || 0);
          const rejectWeight = Number(r.reject_weight || 0);
          const rejectAmount = Number(r.reject_amount || 0);
          const rejectPct = actualShipQty > 0 ? (claimSheetQty / actualShipQty) * 100 : 0;
          return {
            id: r.id,
            name: r.name,
            count: Number(r.count),
            claim_sheet_qty: claimSheetQty,
            actual_ship_qty: actualShipQty,
            reject_weight: rejectWeight,
            reject_amount: rejectAmount,
            reject_pct: Number(rejectPct.toFixed(4)),
          };
        }),
        allProblems: (() => {
          const totalSheets =
            allProblems.reduce((sum, r) => sum + Number(r.claim_sheet_qty || 0), 0) || 1;
          const totalCount = allProblems.reduce((sum, r) => sum + Number(r.count || 0), 0) || 1;
          return allProblems.map((r) => {
            const count = Number(r.count || 0);
            const claimSheetQty = Number(r.claim_sheet_qty || 0);
            return {
              id: r.id,
              name: r.name,
              count,
              claim_sheet_qty: claimSheetQty,
              reject_amount: Number(r.reject_amount || 0),
              reject_pct: Number(((claimSheetQty / totalSheets) * 100).toFixed(4)),
              count_pct: Number(((count / totalCount) * 100).toFixed(4)),
            };
          });
        })(),
        machines: machines.map((r) => ({ ...r, count: Number(r.count) })),
        machinesWithTopProblems,
        machineTopProblems: machineTopProblems.map((r) => ({ ...r, count: Number(r.count) })),
      };
    },

    /** Trend chart payload — fetched separately so summary can paint first. */
    async getRejectTrend(query = {}) {
      const range = await resolveEffectiveRange(query);
      const filterIds = resolveFilterIds(query);
      const requestedGrain = String(query.trend_grain || "").toLowerCase();
      const trendGrain = ["day", "week", "month"].includes(requestedGrain)
        ? requestedGrain
        : resolveTrendGrain(range);
      const payload = await buildRejectTrendPayload(range, filterIds, trendGrain);
      return {
        filters: {
          period: range.period,
          from: range.from,
          to: range.to,
          trend_grain: trendGrain,
        },
        ...payload,
      };
    },

    /** Filter dropdown options — cached briefly; independent of the active period filter. */
    async getRejectFilterOptions() {
      const now = Date.now();
      if (filterOptionsCache && now - filterOptionsCachedAt < FILTER_OPTIONS_TTL_MS) {
        return filterOptionsCache;
      }

      const [[machineOptions], [departmentOptions], [shiftOptions], [jobTypeRows]] =
        await Promise.all([
          pool.query(`SELECT id, name FROM machines WHERE is_active = 1 ORDER BY name ASC`),
          pool.query(`SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC`),
          pool.query(`SELECT id, name FROM shifts WHERE is_active = 1 ORDER BY name ASC`),
          pool.query(
            `SELECT DISTINCT job_type AS name
             FROM reject_records
             WHERE job_type IS NOT NULL AND TRIM(job_type) <> ''
             ORDER BY job_type ASC`,
          ),
        ]);

      const jobTypeOptions = (jobTypeRows.length
        ? jobTypeRows
        : [{ name: "แผ่น" }, { name: "กล่อง" }]
      ).map((row, index) => ({
        id: index + 1,
        name: row.name,
      }));

      filterOptionsCache = {
        machineOptions,
        departmentOptions,
        shiftOptions,
        jobTypeOptions,
      };
      filterOptionsCachedAt = now;
      return filterOptionsCache;
    },

    async getTopComparison(query = {}) {
      const type = String(query.type || "").toLowerCase();
      if (!["problems", "companies"].includes(type)) {
        const err = new Error("type ต้องเป็น problems หรือ companies");
        err.status = 400;
        throw err;
      }

      const requestedPeriods = Number(query.previous_periods || 3);
      if (![3, 5].includes(requestedPeriods)) {
        const err = new Error("previous_periods ต้องเป็น 3 หรือ 5");
        err.status = 400;
        throw err;
      }

      const range = await resolveEffectiveRange(query);
      const grain = comparisonGrain(query, range);
      const periods = buildComparisonPeriods(range, grain, requestedPeriods);
      if (!periods.length) {
        const err = new Error("ไม่สามารถคำนวณช่วงเวลาเปรียบเทียบได้");
        err.status = 400;
        throw err;
      }

      const filterIds = resolveFilterIds(query);
      const currentFilter = buildWhere({ ...range, ...filterIds });
      const isProblems = type === "problems";
      const entityTable = isProblems ? "problems" : "companies";
      const entityAlias = isProblems ? "p" : "c";
      const entityForeignKey = isProblems ? "problem_id" : "company_id";
      const amountSelect = isProblems
        ? ""
        : `, COALESCE(SUM(
             CASE
               WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
               ELSE rr.claim_sheet_qty * rr.price_per_sheet
             END
           ), 0) AS reject_amount`;

      const [currentTop] = await pool.query(
        `SELECT ${entityAlias}.id, ${entityAlias}.name, COUNT(*) AS count${amountSelect}
         FROM reject_records rr
         INNER JOIN ${entityTable} ${entityAlias}
           ON ${entityAlias}.id = rr.${entityForeignKey}
         ${currentFilter.whereSql}
         GROUP BY ${entityAlias}.id, ${entityAlias}.name
         ORDER BY count DESC, ${entityAlias}.name ASC
         LIMIT 5`,
        currentFilter.params,
      );

      if (!currentTop.length) {
        return {
          type,
          grain,
          previous_periods: requestedPeriods,
          periods,
          items: [],
        };
      }

      const entityIds = currentTop.map((row) => Number(row.id));
      const combinedRange = {
        from: periods[0].from,
        to: periods[periods.length - 1].to,
      };
      const combinedFilter = buildWhere({ ...combinedRange, ...filterIds });
      const bucketExpr = trendBucketSql(grain);
      const [rows] = await pool.query(
        `SELECT
           ${bucketExpr} AS period_start,
           ${entityAlias}.id,
           ${entityAlias}.name,
           COUNT(*) AS count${amountSelect}
         FROM reject_records rr
         INNER JOIN ${entityTable} ${entityAlias}
           ON ${entityAlias}.id = rr.${entityForeignKey}
         ${combinedFilter.whereSql}
           AND ${entityAlias}.id IN (${entityIds.map(() => "?").join(", ")})
         GROUP BY ${bucketExpr}, ${entityAlias}.id, ${entityAlias}.name
         ORDER BY period_start ASC, count DESC`,
        [...combinedFilter.params, ...entityIds],
      );

      const periodByStart = new Map(periods.map((item) => [item.from, item]));
      const valuesByEntity = new Map(
        currentTop.map((item) => [
          Number(item.id),
          new Map(periods.map((period) => [
            period.key,
            { period_key: period.key, count: 0, reject_amount: 0 },
          ])),
        ]),
      );

      for (const row of rows) {
        const period = periodByStart.get(normalizeDate(row.period_start));
        const entityValues = valuesByEntity.get(Number(row.id));
        if (!period || !entityValues) continue;
        entityValues.set(period.key, {
          period_key: period.key,
          count: Number(row.count || 0),
          reject_amount: Number(row.reject_amount || 0),
        });
      }

      return {
        type,
        grain,
        previous_periods: requestedPeriods,
        periods,
        items: currentTop.map((item) => {
          const values = [...valuesByEntity.get(Number(item.id)).values()];
          return {
            id: Number(item.id),
            name: item.name,
            current_count: Number(item.count || 0),
            current_reject_amount: Number(item.reject_amount || 0),
            total_count: values.reduce((sum, value) => sum + value.count, 0),
            total_reject_amount: values.reduce((sum, value) => sum + value.reject_amount, 0),
            values,
          };
        }),
      };
    },

    /**
     * Machine comparison matrix — one row per time bucket, one column group per
     * machine (BHS / YUELI / ISOWA / …) holding sheets, value and weight.
     */
    async getMachineComparison(query = {}) {
      const range = await resolveEffectiveRange(query);
      const grain = comparisonGrain(query, range);
      const buckets = resolveMachineComparisonBuckets(query.periods, grain);
      const periods = buildComparisonPeriods(anchorNotInFuture(range), grain, buckets.count - 1);
      if (!periods.length) {
        const err = new Error("ไม่สามารถคำนวณช่วงเวลาเปรียบเทียบได้");
        err.status = 400;
        throw err;
      }

      const filterIds = resolveFilterIds(query);
      const { machineIds } = filterIds;

      const machineWhere = ["m.is_active = 1"];
      const machineParams = [];
      if (machineIds.length) {
        machineWhere.push(`m.id IN (${machineIds.map(() => "?").join(", ")})`);
        machineParams.push(...machineIds);
      }
      const [machineRows] = await pool.query(
        `SELECT m.id, m.name
         FROM machines m
         WHERE ${machineWhere.join(" AND ")}
         ORDER BY m.name ASC`,
        machineParams,
      );

      const combinedRange = {
        from: periods[0].from,
        to: periods[periods.length - 1].to,
      };
      const { whereSql, params } = buildWhere({ ...combinedRange, ...filterIds });
      const bucketExpr = trendBucketSql(grain);
      const moneyExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.price_per_sheet
      END`;
      const weightExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.weight_per_sheet
      END`;

      const [rows] = await pool.query(
        `SELECT
           ${bucketExpr} AS period_start,
           rr.machine_id AS machine_id,
           COUNT(*) AS count,
           COALESCE(SUM(rr.claim_sheet_qty), 0) AS claim_sheet_qty,
           COALESCE(SUM(${moneyExpr}), 0) AS reject_amount,
           COALESCE(SUM(${weightExpr}), 0) AS reject_weight,
           COALESCE(SUM(rr.destroy_bl_weight), 0) AS destroy_bl_weight,
           COALESCE(SUM(rr.destroy_bl_amount), 0) AS destroy_bl_amount,
           COALESCE(SUM(rr.return_to_customer_qty), 0) AS return_to_customer_qty,
           COALESCE(SUM(rr.return_amount), 0) AS return_amount
         FROM reject_records rr
         ${whereSql}
         GROUP BY ${bucketExpr}, rr.machine_id
         ORDER BY period_start ASC`,
        params,
      );

      const machines = machineRows.map((row) => ({
        key: `machine_${row.id}`,
        id: Number(row.id),
        name: row.name,
      }));
      const machineKeyById = new Map(machines.map((item) => [item.id, item.key]));

      const emptyCell = () => ({
        count: 0,
        claim_sheet_qty: 0,
        reject_amount: 0,
        reject_weight: 0,
        destroy_bl_weight: 0,
        destroy_bl_amount: 0,
        return_to_customer_qty: 0,
        return_amount: 0,
      });
      const addCell = (target, source) => {
        target.count += Number(source.count || 0);
        target.claim_sheet_qty += Number(source.claim_sheet_qty || 0);
        target.reject_amount += Number(source.reject_amount || 0);
        target.reject_weight += Number(source.reject_weight || 0);
        target.destroy_bl_weight += Number(source.destroy_bl_weight || 0);
        target.destroy_bl_amount += Number(source.destroy_bl_amount || 0);
        target.return_to_customer_qty += Number(source.return_to_customer_qty || 0);
        target.return_amount += Number(source.return_amount || 0);
      };

      const resultRows = periods.map((period) => ({
        key: period.key,
        label: period.label,
        from: period.from,
        to: period.to,
        current: period.current,
        cells: Object.fromEntries(machines.map((item) => [item.key, emptyCell()])),
        total: emptyCell(),
      }));
      const rowByStart = new Map(resultRows.map((row) => [row.from, row]));

      // Records whose machine is missing or de-activated still belong in the totals.
      let hasOther = false;
      for (const row of rows) {
        const bucket = rowByStart.get(normalizeDate(row.period_start));
        if (!bucket) continue;
        const machineKey = machineKeyById.get(Number(row.machine_id)) || MACHINE_OTHER_KEY;
        if (machineKey === MACHINE_OTHER_KEY) hasOther = true;
        if (!bucket.cells[machineKey]) bucket.cells[machineKey] = emptyCell();
        addCell(bucket.cells[machineKey], row);
        addCell(bucket.total, row);
      }

      const columns = hasOther
        ? [...machines, { key: MACHINE_OTHER_KEY, id: null, name: "อื่นๆ / ไม่ระบุเครื่อง" }]
        : machines;

      const totals = {
        cells: Object.fromEntries(columns.map((item) => [item.key, emptyCell()])),
        total: emptyCell(),
      };
      for (const row of resultRows) {
        for (const column of columns) {
          if (!row.cells[column.key]) row.cells[column.key] = emptyCell();
          addCell(totals.cells[column.key], row.cells[column.key]);
        }
        addCell(totals.total, row.total);
      }

      return {
        grain,
        periods_count: buckets.count,
        periods_options: buckets.options,
        filters: {
          period: range.period,
          from: combinedRange.from,
          to: combinedRange.to,
          machine_ids: machineIds,
          department_ids: filterIds.departmentIds,
          shifts: filterIds.shifts,
          job_types: filterIds.jobTypes,
        },
        machines: columns,
        rows: resultRows,
        totals,
      };
    },

    async getRejectDayDetail(query = {}) {
      return fetchDayDetail(query);
    },

    async getKpiDetail(query = {}) {
      const type = String(query.type || "").toLowerCase();
      const allowed = new Set(["rejects", "amount", "companies", "problems"]);
      if (!allowed.has(type)) {
        const err = new Error("type ต้องเป็น rejects, amount, companies หรือ problems");
        err.status = 400;
        throw err;
      }

      const range = await resolveEffectiveRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });
      const paging = parsePaging(query);

      const moneyExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.price_per_sheet
      END`;
      const weightExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.weight_per_sheet
      END`;

      if (type === "rejects") {
        const page = await listRejectKpiRows(pool, whereSql, params, moneyExpr, weightExpr, paging);
        return {
          type,
          filters: { period: range.period, from: range.from, to: range.to },
          ...page,
        };
      }

      if (type === "amount" || type === "companies") {
        const orderBy =
          type === "amount"
            ? `COALESCE(SUM(${moneyExpr}), 0) DESC, c.name ASC`
            : `COUNT(*) DESC, c.name ASC`;
        const [rows] = await pool.query(
          `SELECT
             c.id,
             c.name,
             COUNT(*) AS count,
             COALESCE(SUM(rr.claim_sheet_qty), 0) AS claim_sheet_qty,
             COALESCE(SUM(${weightExpr}), 0) AS reject_weight,
             COALESCE(SUM(${moneyExpr}), 0) AS reject_amount
           FROM reject_records rr
           INNER JOIN companies c ON c.id = rr.company_id
           ${whereSql}
           GROUP BY c.id, c.name
           ORDER BY ${orderBy}`,
          params,
        );

        const mapped = rows.map((r) => ({
          id: r.id,
          name: r.name,
          count: Number(r.count || 0),
          claim_sheet_qty: Number(r.claim_sheet_qty || 0),
          reject_weight: Number(r.reject_weight || 0),
          reject_amount: Number(r.reject_amount || 0),
        }));
        return {
          type,
          filters: { period: range.period, from: range.from, to: range.to },
          rows: mapped,
          total: mapped.length,
          page: 1,
          pageSize: mapped.length || paging.pageSize,
        };
      }

      const [rows] = await pool.query(
        `SELECT
           p.id,
           p.name,
           COUNT(*) AS count,
           COALESCE(SUM(rr.claim_sheet_qty), 0) AS claim_sheet_qty,
           COALESCE(SUM(${weightExpr}), 0) AS reject_weight,
           COALESCE(SUM(${moneyExpr}), 0) AS reject_amount
         FROM reject_records rr
         INNER JOIN problems p ON p.id = rr.problem_id
         ${whereSql}
         GROUP BY p.id, p.name
         ORDER BY count DESC, p.name ASC`,
        params,
      );

      const mapped = rows.map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count || 0),
        claim_sheet_qty: Number(r.claim_sheet_qty || 0),
        reject_weight: Number(r.reject_weight || 0),
        reject_amount: Number(r.reject_amount || 0),
      }));
      return {
        type,
        filters: { period: range.period, from: range.from, to: range.to },
        rows: mapped,
        total: mapped.length,
        page: 1,
        pageSize: mapped.length || paging.pageSize,
      };
    },

    async getProblemDetail(query = {}) {
      const problemId = Number(query.problem_id);
      if (!Number.isFinite(problemId) || problemId <= 0) {
        const err = new Error("ต้องระบุ problem_id");
        err.status = 400;
        throw err;
      }

      const range = await resolveEffectiveRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });
      const paging = parsePaging(query);

      const [[problem]] = await pool.query(
        `SELECT id, name FROM problems WHERE id = ? LIMIT 1`,
        [problemId],
      );
      if (!problem) {
        const err = new Error("ไม่พบปัญหาที่ระบุ");
        err.status = 404;
        throw err;
      }

      const page = await listRejectEntityRows(
        pool,
        `${whereSql} AND rr.problem_id = ?`,
        [...params, problemId],
        paging,
      );

      return {
        problem: { id: problem.id, name: problem.name },
        filters: { period: range.period, from: range.from, to: range.to },
        ...page,
      };
    },

    async getDepartmentDetail(query = {}) {
      const departmentId = Number(query.department_id);
      if (!Number.isFinite(departmentId) || departmentId <= 0) {
        const err = new Error("ต้องระบุ department_id");
        err.status = 400;
        throw err;
      }

      const range = await resolveEffectiveRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });
      const paging = parsePaging(query);

      const [[department]] = await pool.query(
        `SELECT id, name FROM departments WHERE id = ? LIMIT 1`,
        [departmentId],
      );
      if (!department) {
        const err = new Error("ไม่พบหน่วยงานที่ระบุ");
        err.status = 404;
        throw err;
      }

      const page = await listRejectEntityRows(
        pool,
        `${whereSql} AND rr.department_id = ?`,
        [...params, departmentId],
        paging,
      );

      return {
        department: { id: department.id, name: department.name },
        filters: { period: range.period, from: range.from, to: range.to },
        ...page,
      };
    },
  };
}

function parsePaging(query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 50);
  const page = Math.max(Number(query.page) || 1, 1);
  return { page, pageSize };
}

async function listRejectKpiRows(pool, whereSql, params, moneyExpr, weightExpr, { page = 1, pageSize = 10 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const offset = (current - 1) * size;

  const [[[countRow]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM reject_records rr ${whereSql}`, params),
    pool.query(
      `SELECT
         rr.id,
         rr.reject_received_date AS date,
         COALESCE(c.name, '—') AS company_name,
         COALESCE(d.name, '—') AS department_name,
         COALESCE(m.name, '—') AS machine_name,
         COALESCE(p.name, '—') AS problem_name,
         rr.shift,
         COALESCE(rr.claim_sheet_qty, 0) AS claim_sheet_qty,
         COALESCE(${weightExpr}, 0) AS reject_weight,
         COALESCE(${moneyExpr}, 0) AS reject_amount
       FROM reject_records rr
       LEFT JOIN companies c ON c.id = rr.company_id
       LEFT JOIN departments d ON d.id = rr.department_id
       LEFT JOIN machines m ON m.id = rr.machine_id
       LEFT JOIN problems p ON p.id = rr.problem_id
       ${whereSql}
       ORDER BY rr.reject_received_date DESC, rr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset],
    ),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      date: normalizeDate(r.date),
      company_name: r.company_name,
      department_name: r.department_name,
      machine_name: r.machine_name,
      problem_name: r.problem_name,
      shift: r.shift || "—",
      claim_sheet_qty: Number(r.claim_sheet_qty || 0),
      reject_weight: Number(r.reject_weight || 0),
      reject_amount: Number(r.reject_amount || 0),
    })),
    total: Number(countRow?.total || 0),
    page: current,
    pageSize: size,
  };
}

async function listRejectEntityRows(pool, whereSql, params, { page = 1, pageSize = 10 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const offset = (current - 1) * size;

  const [[[countRow]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM reject_records rr ${whereSql}`, params),
    pool.query(
      `SELECT
         rr.id,
         COALESCE(c.name, '—') AS company_name,
         COALESCE(rr.pdr_no, '—') AS pdr_no,
         COALESCE(rr.size, '—') AS size,
         COALESCE(d.name, '—') AS department_name,
         COALESCE(m.name, '—') AS machine_name,
         COALESCE(rr.claim_sheet_qty, 0) AS claim_sheet_qty,
         rr.reject_received_date AS date
       FROM reject_records rr
       LEFT JOIN companies c ON c.id = rr.company_id
       LEFT JOIN departments d ON d.id = rr.department_id
       LEFT JOIN machines m ON m.id = rr.machine_id
       ${whereSql}
       ORDER BY rr.reject_received_date DESC, rr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset],
    ),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      company_name: r.company_name,
      pdr_no: r.pdr_no || "—",
      size: r.size || "—",
      department_name: r.department_name,
      machine_name: r.machine_name,
      claim_sheet_qty: Number(r.claim_sheet_qty || 0),
      date: normalizeDate(r.date),
    })),
    total: Number(countRow?.total || 0),
    page: current,
    pageSize: size,
  };
}

function pushNamedCount(map, date, name, count) {
  if (!map.has(date)) map.set(date, []);
  map.get(date).push({ name, count: Number(count) });
}

function formatTrendLabel(date, grain) {
  if (!date) return "";
  if (grain === "month") {
    const [y, m] = date.split("-");
    return `${y}-${m}`;
  }
  if (grain === "week") {
    // date = Sunday of that week
    return date;
  }
  return date;
}

function buildStackedTrend({ totals, byMachine, byDepartment, byProblem, grain = "day" }) {
  const machineMap = new Map();
  const departmentMap = new Map();
  const problemMap = new Map();
  const stackTotals = new Map();

  for (const row of byMachine) {
    const date = normalizeDate(row.date);
    if (!date) continue;
    pushNamedCount(machineMap, date, row.name, row.count);
    stackTotals.set(row.name, (stackTotals.get(row.name) || 0) + Number(row.count));
  }
  for (const row of byDepartment) {
    const date = normalizeDate(row.date);
    if (!date) continue;
    pushNamedCount(departmentMap, date, row.name, row.count);
  }
  for (const row of byProblem) {
    const date = normalizeDate(row.date);
    if (!date) continue;
    pushNamedCount(problemMap, date, row.name, row.count);
  }

  const trendStackKeys = [...stackTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "th"))
    .map(([name]) => name);

  const trendRows = totals.map((row) => {
    const date = normalizeDate(row.date);
    const machines = machineMap.get(date) || [];
    const item = {
      date,
      label: formatTrendLabel(date, grain),
      count: Number(row.count),
      machines,
      departments: departmentMap.get(date) || [],
      problems: problemMap.get(date) || [],
    };
    for (const key of trendStackKeys) {
      item[key] = 0;
    }
    for (const machine of machines) {
      item[machine.name] = Number(machine.count);
    }
    return item;
  });

  return { trendRows, trendStackKeys };
}
