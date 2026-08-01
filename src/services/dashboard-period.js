/**
 * Date-range / bucketing helpers shared by the Reject and Complaint dashboards.
 * Weeks follow the company convention: Sunday → Saturday.
 */

export function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function normalizeDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // MySQL DATE arrives as UTC midnight — use ISO date part to avoid TZ shift
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function resolveDateRange(query = {}) {
  const period = String(query.period || "month").toLowerCase();
  const today = new Date();

  if (period === "custom" && query.from && query.to) {
    return {
      period: "custom",
      from: String(query.from).slice(0, 10),
      to: String(query.to).slice(0, 10),
    };
  }

  // Backward compatible: from+to without a known period still means custom
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
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - today.getDay());
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    return { period: "week", from: toIsoDate(sunday), to: toIsoDate(saturday) };
  }

  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { period: "month", from: toIsoDate(from), to: toIsoDate(end) };
}

/**
 * Pick chart bucket size from the selected range so long spans stay readable.
 * day ≤ 31 days · week ≤ 120 days · month for longer / "all"
 */
export function resolveTrendGrain(range) {
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

/** SQL expression that snaps a date column to the start of its bucket. */
export function bucketSql(grain, column) {
  if (grain === "month") return `DATE_FORMAT(${column}, '%Y-%m-01')`;
  if (grain === "week") {
    // Sunday–Saturday week (MySQL DAYOFWEEK: Sun=1 … Sat=7)
    return `DATE_SUB(${column}, INTERVAL DAYOFWEEK(${column}) - 1 DAY)`;
  }
  return column;
}

export function comparisonGrain(query, range) {
  const requested = String(query.grain || "").toLowerCase();
  if (["day", "week", "month"].includes(requested)) return requested;
  if (["day", "week", "month"].includes(range.period)) return range.period;
  if (range.period === "all") return "month";
  return resolveTrendGrain(range);
}

export function comparisonPeriodStart(value, grain) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  if (grain === "week") {
    // Snap to Sunday (getDay: Sun=0 … Sat=6)
    date.setDate(date.getDate() - date.getDay());
  } else if (grain === "month") {
    date.setDate(1);
  }
  return date;
}

export function shiftComparisonPeriod(value, grain, amount) {
  const date = new Date(value);
  if (grain === "month") {
    date.setMonth(date.getMonth() + amount, 1);
  } else {
    date.setDate(date.getDate() + amount * (grain === "week" ? 7 : 1));
  }
  return date;
}

export function comparisonPeriodEnd(start, grain) {
  const end = shiftComparisonPeriod(start, grain, 1);
  end.setDate(end.getDate() - 1);
  return end;
}

export function comparisonPeriodLabel(from, to, grain) {
  if (grain === "month") return from.slice(0, 7);
  if (grain === "week") return `${from} – ${to}`;
  return from;
}

/**
 * Week-of-year the same way MySQL WEEK(date, 0) counts it: weeks start on
 * Sunday and the first Sunday of the year opens week 1.
 */
export function weekOfYear(date) {
  const firstDay = new Date(date.getFullYear(), 0, 1);
  const firstSundayOffset = (7 - firstDay.getDay()) % 7;
  const firstSunday = new Date(date.getFullYear(), 0, 1 + firstSundayOffset);
  if (date < firstSunday) return 0;
  return Math.floor((date - firstSunday) / (7 * 86400000)) + 1;
}

/** Compact column header used by the comparison tables: "M.6" / "W.26" / "12/07". */
export function shortPeriodLabel(from, grain) {
  const date = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(from);
  if (grain === "month") return `M.${date.getMonth() + 1}`;
  if (grain === "week") return `W.${weekOfYear(date)}`;
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function buildComparisonPeriods(range, grain, previousPeriods) {
  const currentStart = comparisonPeriodStart(range.to, grain);
  if (!currentStart) return [];

  return Array.from({ length: previousPeriods + 1 }, (_, index) => {
    const offset = index - previousPeriods;
    const start = shiftComparisonPeriod(currentStart, grain, offset);
    const end = comparisonPeriodEnd(start, grain);
    const from = toIsoDate(start);
    const to = toIsoDate(end);
    return {
      key: `period_${index}`,
      label: comparisonPeriodLabel(from, to, grain),
      short_label: shortPeriodLabel(from, grain),
      from,
      to,
      current: index === previousPeriods,
    };
  });
}

/** "all" resolves to a far-future end date — never anchor comparison buckets there. */
export function anchorNotInFuture(range) {
  const today = toIsoDate(new Date());
  return { ...range, to: range.to && range.to < today ? range.to : today };
}

export function parseIdList(value) {
  if (value == null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => Number(item)).filter((n) => Number.isFinite(n) && n > 0))];
}

export function parseStringList(value) {
  if (value == null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}
