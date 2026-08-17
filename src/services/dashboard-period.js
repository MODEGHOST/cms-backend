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

const KNOWN_PERIODS = ["day", "week", "month", "last_month", "all"];

export function resolveDateRange(query = {}, now = new Date()) {
  const period = String(query.period || "month").toLowerCase();
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  if (period === "custom" && query.from && query.to) {
    return {
      period: "custom",
      from: String(query.from).slice(0, 10),
      to: String(query.to).slice(0, 10),
    };
  }

  // Backward compatible: from+to without a known period still means custom
  if (query.from && query.to && !KNOWN_PERIODS.includes(period)) {
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

  if (period === "last_month") {
    const from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { period: "last_month", from: toIsoDate(from), to: toIsoDate(end) };
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
  if (range.period === "month" || range.period === "last_month") return "day";

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
  if (range.period === "last_month") return "month";
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

/** Display dates as day-month-year so every screen uses the same order. */
export function formatDisplayDate(value) {
  const text = String(value || "").slice(0, 10);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text || "";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function formatDisplayDateRange(from, to) {
  const start = formatDisplayDate(from);
  const end = formatDisplayDate(to);
  if (!start) return end || "";
  if (!end || start === end) return start;
  return `${start} – ${end}`;
}

export function comparisonPeriodLabel(from, to, grain) {
  if (grain === "day") return formatDisplayDate(from);
  return formatDisplayDateRange(from, to);
}

/**
 * Week-of-year like Excel WEEKNUM (Sunday start): week 1 is the week that
 * contains 1 January (may begin in the previous December).
 */
export function weekOfYear(date) {
  const jan1 = new Date(date.getFullYear(), 0, 1);
  const week1Start = new Date(jan1);
  week1Start.setDate(jan1.getDate() - jan1.getDay());
  return Math.floor((date - week1Start) / (7 * 86400000)) + 1;
}

/** Compact column header used by the comparison tables: "M.6" / "W.26" / "12/07". */
export function shortPeriodLabel(from, grain) {
  const date = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(from);
  if (grain === "month") return `M.${date.getMonth() + 1}`;
  if (grain === "week") return `W.${weekOfYear(date)}`;
  return formatDisplayDate(from);
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

/** Rolling windows for Reject % / Complaint % vs unique prod orders (9 types). */
export const RATE_WINDOWS = [
  { key: "day", label: "รายวัน", grain: "day", count: 7 },
  { key: "week", label: "สัปดาห์นี้", grain: "week", count: 1 },
  { key: "week3", label: "3 สัปดาห์", grain: "week", count: 3 },
  { key: "week6", label: "6 สัปดาห์", grain: "week", count: 6 },
  { key: "month", label: "เดือนนี้", grain: "month", count: 1 },
  { key: "month3", label: "3 เดือน", grain: "month", count: 3 },
  { key: "month6", label: "6 เดือน", grain: "month", count: 6 },
];

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Sunday → Saturday week that contains `date`, then stretch back `weekCount - 1` weeks. */
export function weekWindow(date, weekCount = 1) {
  const today = startOfLocalDay(date);
  const sunday = new Date(today);
  sunday.setDate(today.getDate() - today.getDay());
  const from = new Date(sunday);
  from.setDate(sunday.getDate() - (Math.max(1, weekCount) - 1) * 7);
  const to = new Date(sunday);
  to.setDate(sunday.getDate() + 6);
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

/** Calendar month that contains `date`, then stretch back `monthCount - 1` months. */
export function monthWindow(date, monthCount = 1) {
  const today = startOfLocalDay(date);
  const from = new Date(today.getFullYear(), today.getMonth() - (Math.max(1, monthCount) - 1), 1);
  const to = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { from: toIsoDate(from), to: toIsoDate(to) };
}

export function addDaysIso(iso, days) {
  const date = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return toIsoDate(date);
}

export function calendarDaysInclusive(from, to) {
  const start = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  const end = new Date(`${String(to).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.round((end - start) / 86400000) + 1);
}

/**
 * Compare an incomplete current bucket to the same elapsed stretch of the
 * previous bucket (MTD vs previous MTD), so mid-month does not look "improved".
 */
export const PERIOD_LABELS = {
  day: "วันนี้",
  week: "สัปดาห์นี้",
  month: "เดือนนี้",
  last_month: "เดือนที่แล้ว",
  all: "ทั้งหมด",
  custom: "ช่วงที่เลือก",
};

export function pulseVerdict(latest, baseline) {
  if (baseline <= 0) return latest > 0 ? "worse" : "flat";
  const ratio = latest / baseline;
  if (ratio <= 0.9) return "improved";
  if (ratio >= 1.1) return "worse";
  return "flat";
}

/** Same-length window immediately before `range` (for custom spans). */
export function previousEqualRange(range, todayIso = toIsoDate(new Date())) {
  const clippedTo =
    range?.to && String(range.to).slice(0, 10) < todayIso
      ? String(range.to).slice(0, 10)
      : todayIso;
  const from = range?.from ? String(range.from).slice(0, 10) : null;
  if (!from || from > clippedTo) return null;
  const days = calendarDaysInclusive(from, clippedTo);
  if (days <= 0) return null;
  const prevTo = addDaysIso(from, -1);
  const prevFrom = addDaysIso(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo, elapsed_days: days };
}

/**
 * Previous window used by the 10-second company pulse.
 * Calendar day/week/month → same elapsed stretch last period.
 * Custom → the same number of days right before this range.
 */
export function headlineCompareRange(range, todayIso = toIsoDate(new Date())) {
  if (!range || range.period === "all") return null;
  const grain = range.period === "last_month" ? "month" : range.period;
  if (["day", "week", "month"].includes(grain)) {
    const clippedTo = range.to && range.to < todayIso ? range.to : todayIso;
    const pair = likeForLikePair(clippedTo, grain, todayIso);
    return pair
      ? { from: pair.baseline.from, to: pair.baseline.to, elapsed_days: pair.elapsed_days }
      : null;
  }
  return previousEqualRange(range, todayIso);
}

export function likeForLikePair(anchorIso, grain, todayIso = toIsoDate(new Date())) {
  const anchor =
    anchorIso && String(anchorIso).slice(0, 10) < todayIso
      ? String(anchorIso).slice(0, 10)
      : todayIso;
  const currentStart = comparisonPeriodStart(anchor, grain);
  if (!currentStart) return null;
  const currentEndFull = comparisonPeriodEnd(currentStart, grain);
  const currentFrom = toIsoDate(currentStart);
  const currentTo =
    toIsoDate(currentEndFull) > anchor ? anchor : toIsoDate(currentEndFull);
  const elapsed = calendarDaysInclusive(currentFrom, currentTo);
  const prevStart = shiftComparisonPeriod(currentStart, grain, -1);
  const prevEndFull = comparisonPeriodEnd(prevStart, grain);
  const prevFrom = toIsoDate(prevStart);
  const prevToCandidate = addDaysIso(prevFrom, elapsed - 1);
  const prevTo =
    prevToCandidate > toIsoDate(prevEndFull) ? toIsoDate(prevEndFull) : prevToCandidate;
  return {
    latest: { from: currentFrom, to: currentTo },
    baseline: { from: prevFrom, to: prevTo },
    elapsed_days: elapsed,
  };
}

/** The week/month immediately before the latest bucket — used for ดีขึ้น / ต้องปรับปรุง. */
export function previousComparisonPeriod(range, grain) {
  const currentStart = comparisonPeriodStart(range.to, grain);
  if (!currentStart) return null;
  const start = shiftComparisonPeriod(currentStart, grain, -1);
  const end = comparisonPeriodEnd(start, grain);
  const from = toIsoDate(start);
  const to = toIsoDate(end);
  return {
    key: "previous",
    label: comparisonPeriodLabel(from, to, grain),
    short_label: shortPeriodLabel(from, grain),
    from,
    to,
    current: false,
  };
}

const TH_WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function dayColumnLabel(from) {
  const date = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(from);
  const day = TH_WEEKDAYS[date.getDay()] || "";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${day} ${dd}/${mm}/${date.getFullYear()}`;
}

function markCurrentPeriod(periods, todayIso) {
  if (!periods.length) return periods;
  const withCurrent = periods.map((period) => ({
    ...period,
    current: period.from === todayIso,
  }));
  if (!withCurrent.some((period) => period.current)) {
    withCurrent[withCurrent.length - 1].current = true;
  }
  return withCurrent;
}

/**
 * Sun–Sat weeks whose Sunday falls inside the calendar month (month is 1–12).
 * week_of_month is 1-based chronological order within that month.
 * Example Aug 2026: W1=Aug2–8, W2=Aug9–15, … (spillover Jul26–Aug1 is July W4).
 */
export function weeksOfMonth(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return [];

  const first = new Date(y, m - 1, 1, 12);
  const last = new Date(y, m, 0, 12);
  let sunday = new Date(first);
  if (sunday.getDay() !== 0) {
    sunday.setDate(first.getDate() + (7 - first.getDay()));
  }

  const weeks = [];
  while (sunday <= last) {
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    const from = toIsoDate(sunday);
    const to = toIsoDate(saturday);
    const weekOfMonth = weeks.length + 1;
    weeks.push({
      week_of_month: weekOfMonth,
      year: y,
      month: m,
      from,
      to,
      label: `W${weekOfMonth}`,
      short_label: `W${weekOfMonth} M.${m}`,
      month_key: `${y}-${String(m).padStart(2, "0")}`,
    });
    sunday = new Date(sunday);
    sunday.setDate(sunday.getDate() + 7);
  }
  return weeks;
}

/** Label a Sun–Sat week (`from` = Sunday) with its week-of-month in the month it belongs to. */
export function describeWeekByFrom(fromIso) {
  const from = String(fromIso || "").slice(0, 10);
  const start = new Date(`${from}T12:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const saturday = new Date(start);
  saturday.setDate(start.getDate() + 6);

  for (const probe of [start, saturday]) {
    const y = probe.getFullYear();
    const m = probe.getMonth() + 1;
    const hit = weeksOfMonth(y, m).find((week) => week.from === from);
    if (hit) return hit;
  }

  return {
    week_of_month: null,
    year: start.getFullYear(),
    month: start.getMonth() + 1,
    from,
    to: toIsoDate(saturday),
    label: shortPeriodLabel(from, "week"),
    short_label: shortPeriodLabel(from, "week"),
    month_key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
  };
}

/**
 * Always 4 Sun–Sat columns ending at the selected month/week.
 * Example: Aug week 2 → Jul W3, Jul W4, Aug W1, Aug W2.
 *
 * Query: month=YYYY-MM, week=1..N (week_of_month). Defaults to "now".
 */
export function resolveRollingMonthWeeks(query = {}, now = new Date(), weekCount = 4) {
  const today = startOfLocalDay(now);
  const count = Math.max(1, Number(weekCount) || 4);

  let year = today.getFullYear();
  let month = today.getMonth() + 1;
  const monthRaw = String(query.month || "").trim();
  const monthMatch = monthRaw.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    year = Number(monthMatch[1]);
    month = Number(monthMatch[2]);
  }

  const monthWeeks = weeksOfMonth(year, month);
  if (!monthWeeks.length) {
    const err = new Error("ไม่พบสัปดาห์ในเดือนที่เลือก");
    err.status = 400;
    throw err;
  }

  let weekOfMonth = Number(query.week ?? query.week_of_month);
  if (!Number.isFinite(weekOfMonth) || weekOfMonth < 1) {
    // Default: current week if in this month, else last week of month
    const todaySunday = new Date(today);
    todaySunday.setDate(today.getDate() - today.getDay());
    const todayFrom = toIsoDate(todaySunday);
    const current =
      monthWeeks.find((week) => week.from === todayFrom) ||
      monthWeeks[monthWeeks.length - 1];
    weekOfMonth = current.week_of_month;
  }

  const anchor =
    monthWeeks.find((week) => week.week_of_month === weekOfMonth) ||
    monthWeeks[monthWeeks.length - 1];
  weekOfMonth = anchor.week_of_month;

  const anchorStart = new Date(`${anchor.from}T12:00:00`);
  const weeks = Array.from({ length: count }, (_, index) => {
    const offset = index - (count - 1);
    const start = new Date(anchorStart);
    start.setDate(anchorStart.getDate() + offset * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const from = toIsoDate(start);
    const to = toIsoDate(end);
    const meta = describeWeekByFrom(from) || {};
    return {
      key: `w${index + 1}`,
      slot: index + 1,
      from,
      to,
      week_of_month: meta.week_of_month,
      year: meta.year,
      month: meta.month,
      month_key: meta.month_key,
      label: meta.short_label || `W${index + 1}`,
      short_label: meta.short_label || `W${index + 1}`,
      current: index === count - 1,
    };
  });

  // Month options: last 18 months including selected
  const monthOptions = [];
  for (let i = 0; i < 18; i += 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthOptions.push({
      value: key,
      label: `M.${d.getMonth() + 1}/${d.getFullYear()}`,
    });
  }
  const selectedKey = `${year}-${String(month).padStart(2, "0")}`;
  if (!monthOptions.some((item) => item.value === selectedKey)) {
    monthOptions.unshift({
      value: selectedKey,
      label: `M.${month}/${year}`,
    });
  }

  return {
    month: selectedKey,
    year,
    month_number: month,
    week_of_month: weekOfMonth,
    week_count: count,
    weeks,
    month_options: monthOptions,
    week_options: monthWeeks.map((week) => ({
      value: week.week_of_month,
      label: `สัปดาห์ที่ ${week.week_of_month}`,
      from: week.from,
      to: week.to,
    })),
  };
}

export function resolveRateWindows(now = new Date()) {
  const todayIso = toIsoDate(startOfLocalDay(now));
  return RATE_WINDOWS.map((item) => {
    const grain = item.grain;
    const count = item.count;
    const compareGrain = grain === "day" ? "day" : grain;
    const range =
      grain === "month" ? monthWindow(now, count) : weekWindow(now, grain === "day" ? 1 : count);
    const periods = markCurrentPeriod(
      buildComparisonPeriods(range, grain, count - 1).map((period) =>
        grain === "day" ? { ...period, short_label: dayColumnLabel(period.from) } : period,
      ),
      todayIso,
    );
    const pair =
      grain === "day"
        ? {
            latest: { from: todayIso, to: todayIso },
            baseline: { from: addDaysIso(todayIso, -7), to: addDaysIso(todayIso, -7) },
            elapsed_days: 1,
          }
        : likeForLikePair(todayIso, grain, todayIso);
    const baselineRange = pair?.baseline;
    return {
      ...item,
      ...range,
      grain,
      compare_grain: compareGrain,
      periods,
      baseline: baselineRange
        ? {
            key: "previous",
            label: comparisonPeriodLabel(baselineRange.from, baselineRange.to, grain),
            short_label:
              grain === "day"
                ? dayColumnLabel(baselineRange.from)
                : shortPeriodLabel(baselineRange.from, grain),
            from: baselineRange.from,
            to: baselineRange.to,
            current: false,
            like_for_like: true,
            elapsed_days: pair.elapsed_days,
          }
        : previousComparisonPeriod(range, compareGrain),
    };
  });
}
