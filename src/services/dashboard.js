/**
 * Dashboard aggregations — all filtering happens in SQL on the backend.
 */
export function createDashboardService(pool) {
  function toIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function resolveDateRange(query = {}) {
    const period = String(query.period || "month").toLowerCase();
    const today = new Date();

    if (period === "custom" || (query.from && query.to && period === "custom")) {
      if (query.from && query.to) {
        return {
          period: "custom",
          from: String(query.from).slice(0, 10),
          to: String(query.to).slice(0, 10),
        };
      }
    }

    // Backward compatible: from+to without period still means custom
    if (query.from && query.to && !["day", "week", "month", "all"].includes(period)) {
      return {
        period: "custom",
        from: String(query.from).slice(0, 10),
        to: String(query.to).slice(0, 10),
      };
    }

    if (period === "all") {
      return { period: "all", from: "2000-01-01", to: "2100-12-31" };
    }

    if (period === "day") {
      const iso = toIsoDate(today);
      return { period: "day", from: iso, to: iso };
    }

    if (period === "week") {
      const monday = new Date(today);
      const offset = (today.getDay() + 6) % 7;
      monday.setDate(today.getDate() - offset);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return {
        period: "week",
        from: toIsoDate(monday),
        to: toIsoDate(sunday),
      };
    }

    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return { period: "month", from: toIsoDate(from), to: toIsoDate(end) };
  }

  /**
   * Pick chart bucket size from the selected range so long spans stay readable.
   * day ≤ 31 days · week ≤ 120 days · month for longer / "all"
   */
  function resolveTrendGrain(range) {
    if (range.period === "all") return "month";
    if (range.period === "day" || range.period === "week") return "day";
    if (range.period === "month") return "day";

    const from = new Date(`${range.from}T00:00:00`);
    const to = new Date(`${range.to}T00:00:00`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "day";
    const days = Math.round((to - from) / 86400000) + 1;
    if (days <= 31) return "day";
    if (days <= 120) return "week";
    return "month";
  }

  /** SQL expression that buckets reject_received_date for the trend chart. */
  function trendBucketSql(grain) {
    if (grain === "month") {
      return `DATE_FORMAT(rr.reject_received_date, '%Y-%m-01')`;
    }
    if (grain === "week") {
      // Monday-start week (MySQL WEEKDAY: Mon=0 … Sun=6)
      return `DATE_SUB(rr.reject_received_date, INTERVAL WEEKDAY(rr.reject_received_date) DAY)`;
    }
    return `rr.reject_received_date`;
  }

  function parseIdList(value) {
    if (value == null || value === "") return [];
    const raw = Array.isArray(value) ? value : String(value).split(",");
    return [...new Set(raw.map((item) => Number(item)).filter((n) => Number.isFinite(n) && n > 0))];
  }

  function parseStringList(value) {
    if (value == null || value === "") return [];
    const raw = Array.isArray(value) ? value : String(value).split(",");
    return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
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

  return {
    async getRejectSummary(query = {}) {
      const range = resolveDateRange(query);
      const filterIds = resolveFilterIds(query);
      const { machineIds, departmentIds, shifts, jobTypes } = filterIds;
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });
      const recordFilters = buildRecordFilters({ ...range, ...filterIds });
      const joinOnSql = recordFilters.clauses.join(" AND ");
      const joinParams = recordFilters.params;

      const [[kpi]] = await pool.query(
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
      );

      const totalRejectWeight = Number(kpi.total_reject_weight || 0);
      const totalShipWeight = Number(kpi.total_ship_weight || 0);
      const totalRejectAmount = Number(kpi.total_reject_amount || 0);
      const totalShipAmount = Number(kpi.total_ship_amount || 0);
      const weightRejectPct =
        totalShipWeight > 0 ? (totalRejectWeight / totalShipWeight) * 100 : 0;
      const valueRejectPct =
        totalShipAmount > 0 ? (totalRejectAmount / totalShipAmount) * 100 : 0;

      const [topProblems] = await pool.query(
        `SELECT p.id, p.name, COUNT(*) AS count
         FROM reject_records rr
         INNER JOIN problems p ON p.id = rr.problem_id
         ${whereSql}
         GROUP BY p.id, p.name
         ORDER BY count DESC
         LIMIT 5`,
        params,
      );

      const [topCompanies] = await pool.query(
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
      );

      // All active departments (not Top-N) — % Reject vs ship qty
      const deptMasterWhere = ["d.is_active = 1"];
      const deptMasterParams = [...joinParams];
      if (departmentIds.length === 1) {
        deptMasterWhere.push("d.id = ?");
        deptMasterParams.push(departmentIds[0]);
      } else if (departmentIds.length > 1) {
        deptMasterWhere.push(`d.id IN (${departmentIds.map(() => "?").join(", ")})`);
        deptMasterParams.push(...departmentIds);
      }

      const [topDepartments] = await pool.query(
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
      );

      // All active problems (not Top-N)
      const [allProblems] = await pool.query(
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
      );

      const [machines] = await pool.query(
        `SELECT m.id, m.name, COUNT(*) AS count
         FROM reject_records rr
         INNER JOIN machines m ON m.id = rr.machine_id
         ${whereSql}
         GROUP BY m.id, m.name
         ORDER BY count DESC`,
        params,
      );

      // Top 3 problems per machine — always returned (no need to select filter first)
      const [machineProblemRows] = await pool.query(
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
      );

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

      // Keep focused list when machine filter(s) are selected
      const machineTopProblems =
        machineIds.length === 1
          ? machinesWithTopProblems.find((item) => item.id === machineIds[0])?.topProblems || []
          : [];

      const trendGrain = resolveTrendGrain(range);
      const bucketExpr = trendBucketSql(trendGrain);

      const [trend] = await pool.query(
        `SELECT ${bucketExpr} AS date, COUNT(*) AS count
         FROM reject_records rr
         ${whereSql}
         GROUP BY ${bucketExpr}
         ORDER BY date ASC`,
        params,
      );

      const [trendByMachine] = await pool.query(
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
      );

      const [trendByDepartment] = await pool.query(
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
      );

      const [trendByProblem] = await pool.query(
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
      );

      const { trendRows, trendStackKeys } = buildStackedTrend({
        totals: trend,
        byMachine: trendByMachine,
        byDepartment: trendByDepartment,
        byProblem: trendByProblem,
        grain: trendGrain,
      });

      const [machineOptions] = await pool.query(
        `SELECT id, name FROM machines WHERE is_active = 1 ORDER BY name ASC`,
      );

      const [departmentOptions] = await pool.query(
        `SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name ASC`,
      );

      const [shiftOptions] = await pool.query(
        `SELECT id, name FROM shifts WHERE is_active = 1 ORDER BY name ASC`,
      );

      const [jobTypeRows] = await pool.query(
        `SELECT DISTINCT job_type AS name
         FROM reject_records
         WHERE job_type IS NOT NULL AND TRIM(job_type) <> ''
         ORDER BY job_type ASC`,
      );
      const jobTypeOptions = (jobTypeRows.length
        ? jobTypeRows
        : [{ name: "แผ่น" }, { name: "กล่อง" }]
      ).map((row, index) => ({
        id: index + 1,
        name: row.name,
      }));

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
          trend_grain: trendGrain,
        },
        kpi: {
          total_count: Number(kpi.total_count || 0),
          total_claim_sheet_qty: Number(kpi.total_claim_sheet_qty || 0),
          total_actual_ship_qty: Number(kpi.total_actual_ship_qty || 0),
          total_reject_amount: totalRejectAmount,
          // backward-compatible alias
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
          // backward-compatible alias
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
        // Keep sheet-desc order for Top 3 panel (clone then sort)
        // allProblems used by problems bar chart
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
        trend: trendRows,
        trendStackKeys,
        trendGrain,
        machineOptions,
        departmentOptions,
        shiftOptions,
        jobTypeOptions,
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

      const range = resolveDateRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });

      const moneyExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.price_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.price_per_sheet
      END`;
      const weightExpr = `CASE
        WHEN rr.claim_sheet_qty IS NULL OR rr.weight_per_sheet IS NULL THEN 0
        ELSE rr.claim_sheet_qty * rr.weight_per_sheet
      END`;

      if (type === "rejects") {
        const [rows] = await pool.query(
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
           LIMIT 500`,
          params,
        );

        return {
          type,
          filters: { period: range.period, from: range.from, to: range.to },
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

        return {
          type,
          filters: { period: range.period, from: range.from, to: range.to },
          rows: rows.map((r) => ({
            id: r.id,
            name: r.name,
            count: Number(r.count || 0),
            claim_sheet_qty: Number(r.claim_sheet_qty || 0),
            reject_weight: Number(r.reject_weight || 0),
            reject_amount: Number(r.reject_amount || 0),
          })),
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

      return {
        type,
        filters: { period: range.period, from: range.from, to: range.to },
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          count: Number(r.count || 0),
          claim_sheet_qty: Number(r.claim_sheet_qty || 0),
          reject_weight: Number(r.reject_weight || 0),
          reject_amount: Number(r.reject_amount || 0),
        })),
      };
    },

    async getProblemDetail(query = {}) {
      const problemId = Number(query.problem_id);
      if (!Number.isFinite(problemId) || problemId <= 0) {
        const err = new Error("ต้องระบุ problem_id");
        err.status = 400;
        throw err;
      }

      const range = resolveDateRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });

      const [[problem]] = await pool.query(
        `SELECT id, name FROM problems WHERE id = ? LIMIT 1`,
        [problemId],
      );
      if (!problem) {
        const err = new Error("ไม่พบปัญหาที่ระบุ");
        err.status = 404;
        throw err;
      }

      const [rows] = await pool.query(
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
           AND rr.problem_id = ?
         ORDER BY rr.reject_received_date DESC, rr.id DESC
         LIMIT 500`,
        [...params, problemId],
      );

      return {
        problem: { id: problem.id, name: problem.name },
        filters: { period: range.period, from: range.from, to: range.to },
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
      };
    },

    async getDepartmentDetail(query = {}) {
      const departmentId = Number(query.department_id);
      if (!Number.isFinite(departmentId) || departmentId <= 0) {
        const err = new Error("ต้องระบุ department_id");
        err.status = 400;
        throw err;
      }

      const range = resolveDateRange(query);
      const filterIds = resolveFilterIds(query);
      const { whereSql, params } = buildWhere({ ...range, ...filterIds });

      const [[department]] = await pool.query(
        `SELECT id, name FROM departments WHERE id = ? LIMIT 1`,
        [departmentId],
      );
      if (!department) {
        const err = new Error("ไม่พบหน่วยงานที่ระบุ");
        err.status = 404;
        throw err;
      }

      const [rows] = await pool.query(
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
           AND rr.department_id = ?
         ORDER BY rr.reject_received_date DESC, rr.id DESC
         LIMIT 500`,
        [...params, departmentId],
      );

      return {
        department: { id: department.id, name: department.name },
        filters: { period: range.period, from: range.from, to: range.to },
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
      };
    },
  };
}

function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // MySQL DATE arrives as UTC midnight — use ISO date part to avoid TZ shift
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
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
    // date = Monday of that week
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
