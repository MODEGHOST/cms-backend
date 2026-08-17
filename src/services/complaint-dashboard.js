import {
  anchorNotInFuture,
  bucketSql,
  buildComparisonPeriods,
  comparisonGrain,
  headlineCompareRange,
  likeForLikePair,
  PERIOD_LABELS,
  pulseVerdict,
  normalizeDate,
  parseIdList,
  parseStringList,
  resolveDateRange,
  resolveTrendGrain,
  shortPeriodLabel,
  formatDisplayDate,
} from "./dashboard-period.js";
import { config } from "../core/config.js";
import { createConcurrencyGate } from "../utils/concurrency-gate.js";
import { createTtlCache } from "../utils/ttl-cache.js";

/** Short TTL — identical query params return the same payload (no SQL rewrite). */
const dashboardPayloadCache = createTtlCache({ ttlMs: 60_000, maxEntries: 64 });

/** Bucket absorbing series outside the top-N of a stacked trend. */
const OTHER_SERIES_LABEL = "อื่นๆ";

export const WORKFLOW_LABELS = {
  cs_draft: "CS บันทึกร่าง",
  pending_qa: "รอ QA รับเรื่อง",
  qa_review: "QA ตรวจสอบ",
  pending_department: "รอหน่วยงานตอบ",
  department_action: "หน่วยงานดำเนินการ",
  qa_confirm: "QA ยืนยันผล",
  completed: "ปิดเคสแล้ว",
};

/** How many periods the comparison table may show, per grain. */
const SUMMARY_BUCKETS = {
  day: { options: [7, 14, 30], default: 14 },
  week: { options: [4, 8, 12], default: 4 },
  month: { options: [3, 6, 12], default: 6 },
};

/** Group-by dimensions available to the comparison table and drill-downs. */
const DIMENSIONS = {
  department: {
    label: "หน่วยงานที่รับผิดชอบ",
    table: "departments",
    alias: "d",
    column: "responsible_department_id",
    hasNameEn: false,
  },
  problem: {
    label: "ปัญหาที่ร้องเรียน",
    table: "problems",
    alias: "p",
    column: "problem_id",
    hasNameEn: true,
  },
  company: {
    label: "ลูกค้าที่ร้องเรียน",
    table: "companies",
    alias: "c",
    column: "company_id",
    hasNameEn: true,
  },
  machine: {
    label: "เครื่องจักร",
    table: "machines",
    alias: "m",
    column: "machine_id",
    hasNameEn: false,
  },
};

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function num(value) {
  return Number(value || 0);
}

/**
 * Complaint dashboard aggregations — every filter is applied in SQL so the
 * frontend only renders what the backend already narrowed down.
 */
export function createComplaintDashboardService(pool) {
  const NG_QTY = "COALESCE(cr.ng_qty, 0)";
  const DEMAND_QTY = "COALESCE(cr.demand_qty, 0)";

  function resolveFilters(query = {}) {
    return {
      machineIds: parseIdList(query.machine_ids ?? query.machine_id),
      departmentIds: parseIdList(query.department_ids ?? query.department_id),
      problemIds: parseIdList(query.problem_ids ?? query.problem_id),
      companyIds: parseIdList(query.company_ids ?? query.company_id),
      fluteIds: parseIdList(query.flute_ids ?? query.flute_id),
      shifts: parseStringList(query.shifts ?? query.shift),
      grades: parseStringList(query.grades ?? query.grade),
      statuses: parseStringList(query.statuses ?? query.status).filter(
        (item) => item in WORKFLOW_LABELS,
      ),
    };
  }

  function buildRecordFilters({
    from,
    to,
    machineIds = [],
    departmentIds = [],
    problemIds = [],
    companyIds = [],
    fluteIds = [],
    shifts = [],
    grades = [],
    statuses = [],
    includeDrafts = false,
  }) {
    const clauses = ["cr.received_date IS NOT NULL", "cr.received_date BETWEEN ? AND ?"];
    const params = [from, to];

    const addIn = (column, values) => {
      if (!values.length) return;
      clauses.push(`cr.${column} IN (${values.map(() => "?").join(", ")})`);
      params.push(...values);
    };

    addIn("machine_id", machineIds);
    addIn("responsible_department_id", departmentIds);
    addIn("problem_id", problemIds);
    addIn("company_id", companyIds);
    addIn("flute_id", fluteIds);
    addIn("shift", shifts);
    addIn("grade", grades);
    addIn("workflow_status", statuses);
    if (!statuses.length && !includeDrafts) {
      clauses.push("cr.workflow_status <> 'cs_draft'");
    }

    return { clauses, params };
  }

  function buildWhere(options) {
    const { clauses, params } = buildRecordFilters(options);
    return { whereSql: `WHERE ${clauses.join(" AND ")}`, params };
  }

  /** Top-N of one dimension with count + NG quantity. */
  async function topBy(dimensionKey, whereSql, params, limit, orderBy = "count", offset = 0) {
    const dimension = DIMENSIONS[dimensionKey];
    const nameEn = dimension.hasNameEn ? `, ${dimension.alias}.name_en AS name_en` : "";
    const limitSql = limit
      ? `LIMIT ${Number(limit)} OFFSET ${Math.max(0, Number(offset) || 0)}`
      : "";
    const [rows] = await pool.query(
      `SELECT
         ${dimension.alias}.id,
         ${dimension.alias}.name${nameEn},
         COUNT(*) AS count,
         COALESCE(SUM(${NG_QTY}), 0) AS ng_qty,
         COALESCE(SUM(${DEMAND_QTY}), 0) AS demand_qty
       FROM complaint_records cr
       INNER JOIN ${dimension.table} ${dimension.alias}
         ON ${dimension.alias}.id = cr.${dimension.column}
       ${whereSql}
       GROUP BY ${dimension.alias}.id, ${dimension.alias}.name
       ORDER BY ${orderBy === "ng_qty" ? "ng_qty DESC, count DESC" : "count DESC"}, ${dimension.alias}.name ASC
       ${limitSql}`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      name_en: row.name_en || null,
      count: num(row.count),
      ng_qty: num(row.ng_qty),
      demand_qty: num(row.demand_qty),
    }));
  }

  async function trendBreakdown(bucketExpr, joinSql, nameExpr, whereSql, params) {
    const [rows] = await pool.query(
      `SELECT ${bucketExpr} AS date, ${nameExpr} AS name, COUNT(*) AS count
       FROM complaint_records cr
       ${joinSql}
       ${whereSql}
       GROUP BY ${bucketExpr}, name
       ORDER BY date ASC, count DESC`,
      params,
    );
    return rows;
  }

  /** Narrow period=all from 2000–2100 to the actual data span (same rows, cheaper scans). */
  async function resolveEffectiveRange(query = {}) {
    const range = resolveDateRange(query);
    if (range.period !== "all") return range;
    const [[row]] = await pool.query(
      `SELECT MIN(received_date) AS min_date, MAX(received_date) AS max_date
       FROM complaint_records
       WHERE received_date IS NOT NULL`,
    );
    return {
      period: "all",
      from: normalizeDate(row?.min_date) || range.from,
      to: normalizeDate(row?.max_date) || range.to,
    };
  }

  async function buildTrendPayload(range, filters, trendGrain) {
    const { whereSql, params } = buildWhere({ ...range, ...filters });
    const bucketExpr = bucketSql(trendGrain, "cr.received_date");

    const [[trendTotals], byMachine, byDepartment, byProblem] = await Promise.all([
      pool.query(
        `SELECT ${bucketExpr} AS date, COUNT(*) AS count,
                COALESCE(SUM(${NG_QTY}), 0) AS ng_qty
         FROM complaint_records cr
         ${whereSql}
         GROUP BY ${bucketExpr}
         ORDER BY date ASC`,
        params,
      ),
      trendBreakdown(
        bucketExpr,
        "LEFT JOIN machines m ON m.id = cr.machine_id",
        "COALESCE(m.name, 'ไม่ระบุเครื่อง')",
        whereSql,
        params,
      ),
      trendBreakdown(
        bucketExpr,
        "LEFT JOIN departments d ON d.id = cr.responsible_department_id",
        "COALESCE(d.name, 'ไม่ระบุหน่วยงาน')",
        whereSql,
        params,
      ),
      trendBreakdown(
        bucketExpr,
        "LEFT JOIN problems p ON p.id = cr.problem_id",
        "COALESCE(p.name, 'ไม่ระบุปัญหา')",
        whereSql,
        params,
      ),
    ]);

    const machineByDate = groupByDate(byMachine);
    const departmentByDate = groupByDate(byDepartment);
    const problemByDate = groupByDate(byProblem);

    const baseTrend = trendTotals.map((row) => {
      const date = normalizeDate(row.date);
      return {
        date,
        label: shortPeriodLabel(date, trendGrain),
        full_label: formatDisplayDate(date),
        count: num(row.count),
        ng_qty: num(row.ng_qty),
        machines: machineByDate.get(date) || [],
        departments: departmentByDate.get(date) || [],
        problems: problemByDate.get(date) || [],
      };
    });

    return {
      trendGrain,
      trend: baseTrend,
      trendStacks: {
        machine: buildStack(baseTrend, machineByDate, 0),
        department: buildStack(baseTrend, departmentByDate, 0),
        problem: buildStack(baseTrend, problemByDate, 7),
      },
    };
  }

  let filterOptionsCache = null;
  let filterOptionsCachedAt = 0;
  const FILTER_OPTIONS_TTL_MS = 5 * 60 * 1000;

  return {
    /** KPI + rank charts only — no trend stacks / filter option lists. */
    async getSummary(query = {}) {
      const gate = createConcurrencyGate(config.dashboardSqlBatchSize);
      const q = (sql, params) => gate(() => pool.query(sql, params));
      const cacheKey = `complaint-summary:${JSON.stringify(query || {})}`;
      const cached = dashboardPayloadCache.get(cacheKey);
      if (cached != null) return cached;

      const range = await resolveEffectiveRange(query);
      const filters = resolveFilters(query);
      const { whereSql, params } = buildWhere({ ...range, ...filters });
      const { whereSql: statusWhereSql, params: statusParams } = buildWhere({
        ...range,
        ...filters,
        includeDrafts: true,
      });
      const previous = headlineCompareRange(range);
      const prevFilter = previous
        ? buildWhere({ ...previous, ...filters })
        : { whereSql: "", params: [] };

      const [
        [[kpi]],
        [[demandRow]],
        topProblems,
        focusProblems,
        topCompanies,
        departments,
        focusDepartments,
        [grades],
        [statusRows],
        [departmentProblemRows],
        [[prevRow]],
      ] = await Promise.all([
        q(
          `SELECT
             COUNT(*) AS total_count,
             COUNT(DISTINCT cr.company_id) AS company_count,
             COUNT(DISTINCT cr.problem_id) AS problem_count,
             COUNT(DISTINCT cr.responsible_department_id) AS department_count,
             COALESCE(SUM(${NG_QTY}), 0) AS total_ng_qty,
             COALESCE(SUM(${DEMAND_QTY}), 0) AS total_demand_qty,
             SUM(cr.workflow_status = 'completed') AS completed_count,
             SUM(cr.completed_date IS NOT NULL) AS closed_count,
             AVG(
               CASE
                 WHEN cr.document_accepted = 'P'
                  AND cr.doc_forward_date IS NOT NULL
                  AND cr.doc_reply_date IS NOT NULL
                  AND cr.doc_reply_date >= cr.doc_forward_date
                 THEN DATEDIFF(cr.doc_reply_date, cr.doc_forward_date)
               END
             ) AS avg_lead_time_days
           FROM complaint_records cr
           ${whereSql}`,
          params,
        ),
        q(
          `SELECT COALESCE(SUM(demand_qty), 0) AS unique_demand_qty
           FROM (
             SELECT MAX(COALESCE(cr.demand_qty, 0)) AS demand_qty
             FROM complaint_records cr
             ${whereSql}
             GROUP BY COALESCE(NULLIF(TRIM(cr.pdr_no), ''), CONCAT('#', cr.id))
           ) orders`,
          params,
        ),
        topBy("problem", whereSql, params, 5),
        topBy("problem", whereSql, params, 3, "ng_qty"),
        topBy("company", whereSql, params, 5),
        topBy("department", whereSql, params, null),
        topBy("department", whereSql, params, 3, "ng_qty"),
        q(
          `SELECT COALESCE(NULLIF(TRIM(cr.grade), ''), 'ไม่ระบุ') AS name, COUNT(*) AS count
           FROM complaint_records cr
           ${whereSql}
           GROUP BY name
           ORDER BY count DESC`,
          params,
        ),
        q(
          `SELECT cr.workflow_status AS status, COUNT(*) AS count
           FROM complaint_records cr
           ${statusWhereSql}
           GROUP BY cr.workflow_status`,
          statusParams,
        ),
        q(
          `SELECT ranked.department_id, ranked.department_name,
                  ranked.problem_id, ranked.problem_name, ranked.problem_name_en, ranked.count
           FROM (
             SELECT
               d.id AS department_id,
               d.name AS department_name,
               p.id AS problem_id,
               p.name AS problem_name,
               p.name_en AS problem_name_en,
               COUNT(*) AS count,
               ROW_NUMBER() OVER (
                 PARTITION BY d.id ORDER BY COUNT(*) DESC, p.name ASC
               ) AS rn
             FROM complaint_records cr
             INNER JOIN departments d ON d.id = cr.responsible_department_id
             INNER JOIN problems p ON p.id = cr.problem_id
             ${whereSql}
             GROUP BY d.id, d.name, p.id, p.name, p.name_en
           ) ranked
           WHERE ranked.rn <= 3
           ORDER BY ranked.department_name ASC, ranked.count DESC`,
          params,
        ),
        previous
          ? q(
              `SELECT COUNT(*) AS total_count,
                      COALESCE(SUM(${NG_QTY}), 0) AS total_ng_qty
               FROM complaint_records cr ${prevFilter.whereSql}`,
              prevFilter.params,
            )
          : Promise.resolve([[{ total_count: null, total_ng_qty: null }]]),
      ]);

      const totalCount = num(kpi.total_count);
      const totalNgQty = num(kpi.total_ng_qty);
      const totalDemandQty = num(demandRow?.unique_demand_qty ?? kpi.total_demand_qty);
      const completedCount = num(kpi.completed_count);

      const departmentMap = new Map(
        departments.map((item) => ({ ...item, topProblems: [] })).map((item) => [item.id, item]),
      );
      for (const row of departmentProblemRows) {
        const bucket = departmentMap.get(row.department_id);
        if (!bucket) continue;
        bucket.topProblems.push({
          id: row.problem_id,
          name: row.problem_name,
          name_en: row.problem_name_en || null,
          count: num(row.count),
        });
      }

      const statusByKey = new Map(statusRows.map((row) => [row.status, num(row.count)]));
      const openCount = Math.max(0, totalCount - completedCount);

      const result = {
        filters: {
          period: range.period,
          from: range.from,
          to: range.to,
          machine_ids: filters.machineIds,
          department_ids: filters.departmentIds,
          problem_ids: filters.problemIds,
          company_ids: filters.companyIds,
          flute_ids: filters.fluteIds,
          shifts: filters.shifts,
          grades: filters.grades,
          statuses: filters.statuses,
        },
        kpi: {
          total_count: totalCount,
          company_count: num(kpi.company_count),
          problem_count: num(kpi.problem_count),
          department_count: num(kpi.department_count),
          total_ng_qty: totalNgQty,
          total_demand_qty: totalDemandQty,
          ng_pct: totalDemandQty > 0 ? Number(((totalNgQty / totalDemandQty) * 100).toFixed(4)) : 0,
          ng_pct_note: "ของเสีย ÷ ยอดสั่งของใบ Complaint (นับใบสั่งไม่ซ้ำ · ไม่ใช่ยอดทั้งโรงงาน)",
          completed_count: completedCount,
          open_count: openCount,
          completed_pct:
            totalCount > 0 ? Number(((completedCount / totalCount) * 100).toFixed(2)) : 0,
          avg_lead_time_days:
            kpi.avg_lead_time_days == null ? null : Number(Number(kpi.avg_lead_time_days).toFixed(1)),
        },
        topProblems,
        focusProblems,
        focusDepartments,
        topCompanies,
        topDepartments: departments.slice(0, 5),
        departments,
        departmentsWithTopProblems: [...departmentMap.values()],
        headline: {
          kind: "complaint",
          period: range.period,
          period_label: PERIOD_LABELS[range.period] || "ช่วงที่เลือก",
          from: range.from,
          to: range.to,
          count: totalCount,
          previous_count: prevRow?.total_count == null ? null : num(prevRow.total_count),
          ng_qty: totalNgQty,
          previous_ng_qty: prevRow?.total_ng_qty == null ? null : num(prevRow.total_ng_qty),
          previous_from: previous?.from || null,
          previous_to: previous?.to || null,
          status:
            prevRow?.total_ng_qty == null
              ? null
              : pulseVerdict(totalNgQty, num(prevRow.total_ng_qty)),
          focus_department: focusDepartments[0]?.name || null,
          focus_problem: focusProblems[0]?.name || null,
          focus_problems: focusProblems.slice(0, 3).map((item) => item.name),
        },
        grades: grades.map((row) => ({ name: row.name, count: num(row.count) })),
        statuses: Object.keys(WORKFLOW_LABELS).map((status) => ({
          status,
          label: WORKFLOW_LABELS[status],
          count: statusByKey.get(status) || 0,
        })),
      };
      return dashboardPayloadCache.set(cacheKey, result);
    },

    /** Trend chart payload — fetched separately so grain changes do not reload KPI charts. */
    async getTrend(query = {}) {
      const cacheKey = `complaint-trend:${JSON.stringify(query || {})}`;
      const cached = dashboardPayloadCache.get(cacheKey);
      if (cached != null) return cached;

      const range = await resolveEffectiveRange(query);
      const filters = resolveFilters(query);
      const requestedGrain = String(query.trend_grain || "").toLowerCase();
      const trendGrain = ["day", "week", "month"].includes(requestedGrain)
        ? requestedGrain
        : resolveTrendGrain(range);
      const payload = await buildTrendPayload(range, filters, trendGrain);
      const result = {
        filters: {
          period: range.period,
          from: range.from,
          to: range.to,
          trend_grain: trendGrain,
        },
        ...payload,
      };
      return dashboardPayloadCache.set(cacheKey, result);
    },

    /** Filter dropdown options — cached briefly; independent of the active period filter. */
    async getFilterOptions() {
      const now = Date.now();
      if (filterOptionsCache && now - filterOptionsCachedAt < FILTER_OPTIONS_TTL_MS) {
        return filterOptionsCache;
      }

      const [
        [machineOptions],
        [departmentOptions],
        [problemOptions],
        [companyOptions],
        [fluteOptions],
        [shiftOptions],
        [gradeOptions],
      ] = await Promise.all([
        pool.query(`SELECT id, name FROM machines WHERE is_active = 1 ORDER BY name ASC`),
        pool.query(
          `SELECT DISTINCT d.id, d.name
           FROM complaint_records cr
           INNER JOIN departments d ON d.id = cr.responsible_department_id
           ORDER BY d.name ASC`,
        ),
        pool.query(
          `SELECT DISTINCT p.id, p.name, p.name_en
           FROM complaint_records cr
           INNER JOIN problems p ON p.id = cr.problem_id
           ORDER BY p.name ASC`,
        ),
        pool.query(
          `SELECT DISTINCT c.id, c.name, c.name_en
           FROM complaint_records cr
           INNER JOIN companies c ON c.id = cr.company_id
           ORDER BY c.name ASC`,
        ),
        pool.query(`SELECT id, name FROM flutes WHERE is_active = 1 ORDER BY name ASC`),
        pool.query(`SELECT id, name FROM shifts WHERE is_active = 1 ORDER BY name ASC`),
        pool.query(
          `SELECT DISTINCT TRIM(grade) AS name
           FROM complaint_records
           WHERE grade IS NOT NULL AND TRIM(grade) <> ''
           ORDER BY name ASC`,
        ),
      ]);

      filterOptionsCache = {
        machineOptions,
        departmentOptions,
        problemOptions,
        companyOptions,
        fluteOptions,
        shiftOptions,
        gradeOptions: gradeOptions.map((row, index) => ({ id: index + 1, name: row.name })),
      };
      filterOptionsCachedAt = now;
      return filterOptionsCache;
    },

    /**
     * Comparison matrix: one row per entity of the chosen dimension, one column
     * per month / week / day bucket, plus a trend verdict on the latest bucket.
     */
    async getSummaryTable(query = {}) {
      const dimensionKey = String(query.dimension || "department").toLowerCase();
      const dimension = DIMENSIONS[dimensionKey];
      if (!dimension) {
        throw badRequest("dimension ต้องเป็น department, problem, company หรือ machine");
      }

      const range = await resolveEffectiveRange(query);
      const grain = comparisonGrain(query, range);
      const bucketConfig = SUMMARY_BUCKETS[grain] || SUMMARY_BUCKETS.month;
      const requestedCount = Number(query.periods);
      const periodsCount = bucketConfig.options.includes(requestedCount)
        ? requestedCount
        : bucketConfig.default;

      const filters = resolveFilters(query);
      const anchor = await resolveDataAnchor(pool, buildWhere({ ...range, ...filters }), range);
      const periods = buildComparisonPeriods({ ...range, to: anchor }, grain, periodsCount - 1);
      if (!periods.length) throw badRequest("ไม่สามารถคำนวณช่วงเวลาเปรียบเทียบได้");

      const combinedRange = { from: periods[0].from, to: periods[periods.length - 1].to };
      const { whereSql, params } = buildWhere({ ...combinedRange, ...filters });
      const bucketExpr = bucketSql(grain, "cr.received_date");
      const nameEn = dimension.hasNameEn ? `, ${dimension.alias}.name_en AS name_en` : "";

      const [rows] = await pool.query(
        `SELECT
           ${bucketExpr} AS period_start,
           ${dimension.alias}.id AS entity_id,
           ${dimension.alias}.name AS entity_name${nameEn},
           bp.id AS problem_id,
           bp.name AS problem_name,
           COUNT(*) AS count,
           COALESCE(SUM(${NG_QTY}), 0) AS ng_qty
         FROM complaint_records cr
         INNER JOIN ${dimension.table} ${dimension.alias}
           ON ${dimension.alias}.id = cr.${dimension.column}
         LEFT JOIN problems bp ON bp.id = cr.problem_id
         ${whereSql}
         GROUP BY period_start, entity_id, entity_name, bp.id, bp.name
         ORDER BY period_start ASC`,
        params,
      );

      const periodKeyByStart = new Map(periods.map((item) => [item.from, item.key]));
      const emptyValues = () =>
        Object.fromEntries(periods.map((item) => [item.key, { count: 0, ng_qty: 0 }]));

      const entities = new Map();
      const periodTotals = emptyValues();
      let grandTotal = 0;

      for (const row of rows) {
        const periodKey = periodKeyByStart.get(normalizeDate(row.period_start));
        if (!periodKey) continue;
        const count = num(row.count);
        const ngQty = num(row.ng_qty);

        if (!entities.has(row.entity_id)) {
          entities.set(row.entity_id, {
            id: row.entity_id,
            name: row.entity_name,
            name_en: row.name_en || null,
            values: emptyValues(),
            problems: new Map(),
          });
        }
        const entity = entities.get(row.entity_id);
        entity.values[periodKey].count += count;
        entity.values[periodKey].ng_qty += ngQty;

        const problemId = row.problem_id || 0;
        if (!entity.problems.has(problemId)) {
          entity.problems.set(problemId, {
            id: problemId,
            name: row.problem_name || "ไม่ระบุปัญหา",
            values: emptyValues(),
          });
        }
        const problem = entity.problems.get(problemId);
        problem.values[periodKey].count += count;
        problem.values[periodKey].ng_qty += ngQty;

        periodTotals[periodKey].count += count;
        periodTotals[periodKey].ng_qty += ngQty;
        grandTotal += count;
      }

      const pair = likeForLikePair(anchor, grain);
      const likeMap = new Map();
      if (pair) {
        const { whereSql: pairWhere, params: pairParams } = buildWhere({
          from: pair.baseline.from,
          to: pair.latest.to,
          ...filters,
        });
        const [pairRows] = await pool.query(
          `SELECT ${dimension.alias}.id AS id,
                  SUM(cr.received_date BETWEEN ? AND ?) AS latest,
                  SUM(cr.received_date BETWEEN ? AND ?) AS baseline
           FROM complaint_records cr
           INNER JOIN ${dimension.table} ${dimension.alias}
             ON ${dimension.alias}.id = cr.${dimension.column}
           ${pairWhere}
           GROUP BY ${dimension.alias}.id`,
          [pair.latest.from, pair.latest.to, pair.baseline.from, pair.baseline.to, ...pairParams],
        );
        for (const row of pairRows) likeMap.set(row.id, row);
      }

      const toRow = (item, periodTotalsRef) => {
        const values = periods.map((period) => {
          const cell = item.values[period.key];
          const periodTotal = periodTotalsRef[period.key].count;
          return {
            period_key: period.key,
            count: cell.count,
            ng_qty: cell.ng_qty,
            share_pct: periodTotal > 0 ? Number(((cell.count / periodTotal) * 100).toFixed(2)) : 0,
          };
        });
        const totalCount = values.reduce((sum, value) => sum + value.count, 0);
        const totalNgQty = values.reduce((sum, value) => sum + value.ng_qty, 0);
        const like = likeMap.get(item.id);
        const latest = like ? num(like.latest) : values[values.length - 1]?.count || 0;
        const history = values.slice(0, -1);
        const baseline = like
          ? num(like.baseline)
          : history.length
            ? history.reduce((sum, value) => sum + value.count, 0) / history.length
            : latest;

        return {
          id: item.id,
          name: item.name,
          name_en: item.name_en || null,
          values,
          total_count: totalCount,
          total_ng_qty: totalNgQty,
          avg_count: Number(baseline.toFixed(2)),
          latest_count: latest,
          delta: Number((latest - baseline).toFixed(2)),
          status: verdict(latest, baseline),
        };
      };

      const resultRows = [...entities.values()]
        .map((entity) => {
          const row = toRow(entity, periodTotals);
          const children = [...entity.problems.values()]
            .map((problem) => toRow(problem, entity.values))
            .sort((a, b) => b.total_count - a.total_count || a.name.localeCompare(b.name, "th"));
          return {
            ...row,
            key: `${dimensionKey}_${entity.id}`,
            top_problems: children.slice(0, 3).map((child) => child.name),
            children: children.map((child) => ({
              ...child,
              key: `${dimensionKey}_${entity.id}_problem_${child.id}`,
            })),
          };
        })
        .sort((a, b) => b.total_count - a.total_count || a.name.localeCompare(b.name, "th"));

      const totals = toRow(
        { id: 0, name: "รวมทั้งหมด", values: periodTotals },
        periodTotals,
      );

      return {
        dimension: dimensionKey,
        dimension_label: dimension.label,
        grain,
        periods_count: periodsCount,
        periods_options: bucketConfig.options,
        filters: {
          period: range.period,
          from: combinedRange.from,
          to: combinedRange.to,
          anchor,
        },
        periods,
        rows: resultRows,
        totals: { ...totals, key: "totals", grand_total: grandTotal },
      };
    },

    async getKpiDetail(query = {}) {
      const type = String(query.type || "").toLowerCase();
      const range = await resolveEffectiveRange(query);
      const filters = resolveFilters(query);
      const { whereSql, params } = buildWhere({ ...range, ...filters });
      const paging = parsePaging(query);

      if (type === "complaints") {
        const page = await listRecords(pool, whereSql, params, paging);
        return {
          type,
          filters: { period: range.period, from: range.from, to: range.to },
          ...page,
        };
      }

      const dimensionByType = {
        companies: "company",
        problems: "problem",
        departments: "department",
      };
      const dimensionKey = dimensionByType[type];
      if (!dimensionKey) {
        throw badRequest("type ต้องเป็น complaints, companies, problems หรือ departments");
      }

      const dimension = DIMENSIONS[dimensionKey];
      const offset = (paging.page - 1) * paging.pageSize;
      const [[[countRow]], rows] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) AS total FROM (
             SELECT ${dimension.alias}.id
             FROM complaint_records cr
             INNER JOIN ${dimension.table} ${dimension.alias}
               ON ${dimension.alias}.id = cr.${dimension.column}
             ${whereSql}
             GROUP BY ${dimension.alias}.id
           ) grouped`,
          params,
        ),
        topBy(dimensionKey, whereSql, params, paging.pageSize, "count", offset),
      ]);
      return {
        type,
        filters: { period: range.period, from: range.from, to: range.to },
        rows,
        total: Number(countRow?.total || 0),
        page: paging.page,
        pageSize: paging.pageSize,
      };
    },

    /** Records behind one bar / slice / table row. */
    async getEntityDetail(query = {}) {
      const dimensionKey = String(query.dimension || "").toLowerCase();
      const dimension = DIMENSIONS[dimensionKey];
      if (!dimension) {
        throw badRequest("dimension ต้องเป็น department, problem, company หรือ machine");
      }
      const entityId = Number(query.id);
      if (!Number.isFinite(entityId) || entityId <= 0) throw badRequest("ต้องระบุ id");

      const range = await resolveEffectiveRange(query);
      const filters = resolveFilters(query);
      const { whereSql, params } = buildWhere({ ...range, ...filters });
      const paging = parsePaging(query);

      const [[entity]] = await pool.query(
        `SELECT id, name FROM ${dimension.table} WHERE id = ? LIMIT 1`,
        [entityId],
      );
      if (!entity) {
        const error = new Error("ไม่พบรายการที่ระบุ");
        error.status = 404;
        throw error;
      }

      const extraSql = `AND cr.${dimension.column} = ?`;
      const problemId = Number(query.problem_id);
      const hasProblem = Number.isFinite(problemId) && problemId > 0;
      const page = await listRecords(
        pool,
        `${whereSql} ${extraSql}${hasProblem ? " AND cr.problem_id = ?" : ""}`,
        hasProblem ? [...params, entityId, problemId] : [...params, entityId],
        paging,
      );

      return {
        dimension: dimensionKey,
        entity: { id: entity.id, name: entity.name },
        filters: { period: range.period, from: range.from, to: range.to },
        ...page,
      };
    },
  };
}

/**
 * End the comparison window on the newest complaint inside the filtered range —
 * anchoring on "today" would leave the "latest" column empty whenever the
 * current month or week has no complaints yet.
 */
async function resolveDataAnchor(pool, { whereSql, params }, range) {
  const [[row]] = await pool.query(
    `SELECT MAX(cr.received_date) AS max_date FROM complaint_records cr ${whereSql}`,
    params,
  );
  return normalizeDate(row?.max_date) || anchorNotInFuture(range).to;
}

function parsePaging(query = {}) {
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 10, 1), 50);
  const page = Math.max(Number(query.page) || 1, 1);
  return { page, pageSize };
}

async function listRecords(pool, whereSql, params, { page = 1, pageSize = 10 } = {}) {
  const size = Math.min(Math.max(Number(pageSize) || 10, 1), 50);
  const current = Math.max(Number(page) || 1, 1);
  const offset = (current - 1) * size;

  const [[[countRow]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total FROM complaint_records cr ${whereSql}`, params),
    pool.query(
      `SELECT
         cr.id,
         cr.received_date AS date,
         cr.pdr_no,
         cr.document_no,
         COALESCE(c.name, '—') AS company_name,
         c.name_en AS company_name_en,
         COALESCE(p.name, '—') AS problem_name,
         p.name_en AS problem_name_en,
         COALESCE(d.name, '—') AS department_name,
         COALESCE(m.name, '—') AS machine_name,
         COALESCE(f.name, '—') AS flute_name,
         cr.product_name,
         cr.shift,
         cr.grade,
         COALESCE(cr.demand_qty, 0) AS demand_qty,
         COALESCE(cr.ng_qty, 0) AS ng_qty,
         cr.workflow_status
       FROM complaint_records cr
       LEFT JOIN companies c ON c.id = cr.company_id
       LEFT JOIN problems p ON p.id = cr.problem_id
       LEFT JOIN departments d ON d.id = cr.responsible_department_id
       LEFT JOIN machines m ON m.id = cr.machine_id
       LEFT JOIN flutes f ON f.id = cr.flute_id
       ${whereSql}
       ORDER BY cr.received_date DESC, cr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, size, offset],
    ),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      date: normalizeDate(row.date),
      pdr_no: row.pdr_no || "—",
      document_no: row.document_no || "—",
      company_name: row.company_name,
      company_name_en: row.company_name_en || null,
      problem_name: row.problem_name,
      problem_name_en: row.problem_name_en || null,
      department_name: row.department_name,
      machine_name: row.machine_name,
      flute_name: row.flute_name,
      product_name: row.product_name || "—",
      shift: row.shift || "—",
      grade: row.grade || "—",
      demand_qty: num(row.demand_qty),
      ng_qty: num(row.ng_qty),
      workflow_status: row.workflow_status,
      workflow_label: WORKFLOW_LABELS[row.workflow_status] || row.workflow_status,
    })),
    total: num(countRow?.total),
    page: current,
    pageSize: size,
  };
}

/** Latest bucket against the average of the earlier ones (±10% counts as flat). */
function verdict(latest, baseline) {
  if (baseline <= 0) return latest > 0 ? "worse" : "flat";
  const ratio = latest / baseline;
  if (ratio <= 0.9) return "improved";
  if (ratio >= 1.1) return "worse";
  return "flat";
}

function groupByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = normalizeDate(row.date);
    if (!date) continue;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ name: row.name, count: num(row.count) });
  }
  return map;
}

/**
 * Turn a per-date breakdown into Recharts stack keys plus rows carrying one
 * numeric field per key. Series beyond `limit` collapse into "อื่นๆ".
 */
function buildStack(baseRows, byDate, limit) {
  const totals = new Map();
  for (const items of byDate.values()) {
    for (const item of items) {
      totals.set(item.name, (totals.get(item.name) || 0) + item.count);
    }
  }

  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "th"))
    .map(([name]) => name);
  const kept = limit > 0 ? ranked.slice(0, limit) : ranked;
  const keptSet = new Set(kept);
  const keys = ranked.length > kept.length ? [...kept, OTHER_SERIES_LABEL] : kept;

  const rows = baseRows.map((row) => {
    const item = { ...row };
    for (const key of keys) item[key] = 0;
    for (const entry of byDate.get(row.date) || []) {
      const key = keptSet.has(entry.name) ? entry.name : OTHER_SERIES_LABEL;
      item[key] = (item[key] || 0) + entry.count;
    }
    return item;
  });

  return { keys, rows };
}
