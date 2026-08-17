import test from "node:test";
import assert from "node:assert/strict";
import {
  headlineCompareRange,
  likeForLikePair,
  monthWindow,
  previousComparisonPeriod,
  resolveDateRange,
  resolveRateWindows,
  resolveRollingMonthWeeks,
  weekOfYear,
  weeksOfMonth,
  weekWindow,
} from "../src/services/dashboard-period.js";

const TUE_11_AUG_2026 = new Date(2026, 7, 11);

test("weekOfYear matches Excel WEEKNUM (week containing Jan 1 is week 1)", () => {
  assert.equal(weekOfYear(new Date(2026, 0, 1, 12)), 1);
  assert.equal(weekOfYear(new Date(2026, 0, 3, 12)), 1);
  assert.equal(weekOfYear(new Date(2026, 0, 4, 12)), 2);
  assert.equal(weekOfYear(new Date(2026, 7, 2, 12)), 32);
  assert.equal(weekOfYear(new Date(2026, 7, 9, 12)), 33);
});

test("weekWindow uses Sunday–Saturday and rolls back whole weeks", () => {
  assert.deepEqual(weekWindow(TUE_11_AUG_2026, 1), {
    from: "2026-08-09",
    to: "2026-08-15",
  });
  assert.deepEqual(weekWindow(TUE_11_AUG_2026, 3), {
    from: "2026-07-26",
    to: "2026-08-15",
  });
  assert.deepEqual(weekWindow(TUE_11_AUG_2026, 6), {
    from: "2026-07-05",
    to: "2026-08-15",
  });
});

test("monthWindow uses calendar months including the current month", () => {
  assert.deepEqual(monthWindow(TUE_11_AUG_2026, 1), {
    from: "2026-08-01",
    to: "2026-08-31",
  });
  assert.deepEqual(monthWindow(TUE_11_AUG_2026, 3), {
    from: "2026-06-01",
    to: "2026-08-31",
  });
  assert.deepEqual(monthWindow(TUE_11_AUG_2026, 6), {
    from: "2026-03-01",
    to: "2026-08-31",
  });
});

test("resolveRateWindows returns the six dashboard comparison filters", () => {
  const windows = resolveRateWindows(TUE_11_AUG_2026);
  assert.deepEqual(
    windows.map((item) => item.key),
    ["day", "week", "week3", "week6", "month", "month3", "month6"],
  );
  assert.equal(windows.find((item) => item.key === "week").label, "สัปดาห์นี้");
  assert.equal(windows.find((item) => item.key === "month6").from, "2026-03-01");
});

test("day window expands into 7 daily columns Sunday–Saturday", () => {
  const day = resolveRateWindows(TUE_11_AUG_2026).find((item) => item.key === "day");
  assert.equal(day.grain, "day");
  assert.equal(day.compare_grain, "day");
  assert.equal(day.periods.length, 7);
  assert.equal(day.periods[0].from, "2026-08-09");
  assert.equal(day.periods[6].from, "2026-08-15");
  assert.equal(day.periods[0].short_label, "อา 09/08/2026");
  assert.equal(day.periods[2].short_label, "อ 11/08/2026");
  assert.equal(day.periods[2].current, true);
  assert.equal(day.baseline.from, "2026-08-04");
  assert.equal(day.baseline.to, "2026-08-04");
});

test("resolveRateWindows expands 3 weeks and 6 months into period columns", () => {
  const windows = resolveRateWindows(TUE_11_AUG_2026);
  const week3 = windows.find((item) => item.key === "week3");
  assert.equal(week3.grain, "week");
  assert.equal(week3.periods.length, 3);
  assert.equal(week3.periods[0].from, "2026-07-26");
  assert.equal(week3.periods[2].from, "2026-08-09");
  assert.equal(week3.periods[2].current, true);

  const month6 = windows.find((item) => item.key === "month6");
  assert.equal(month6.grain, "month");
  assert.equal(month6.periods.length, 6);
  assert.equal(month6.periods[0].from, "2026-03-01");
  assert.equal(month6.periods[5].short_label, "M.8");
  assert.equal(month6.baseline.from, "2026-07-01");
  assert.equal(month6.baseline.to, "2026-07-11");
});

test("previousComparisonPeriod is the week or month right before the latest", () => {
  assert.deepEqual(
    previousComparisonPeriod({ from: "2026-08-09", to: "2026-08-15" }, "week"),
    {
      key: "previous",
      label: "02/08/2026 – 08/08/2026",
      short_label: "W.32",
      from: "2026-08-02",
      to: "2026-08-08",
      current: false,
    },
  );
  assert.equal(
    previousComparisonPeriod({ from: "2026-08-01", to: "2026-08-31" }, "month").from,
    "2026-07-01",
  );
});

test("headlineCompareRange uses MTD vs previous MTD for เดือนนี้", () => {
  const range = headlineCompareRange(
    { period: "month", from: "2026-08-01", to: "2026-08-31" },
    "2026-08-11",
  );
  assert.deepEqual(range, { from: "2026-07-01", to: "2026-07-11", elapsed_days: 11 });
});

test("resolveDateRange last_month is the full previous calendar month", () => {
  assert.deepEqual(resolveDateRange({ period: "last_month" }, TUE_11_AUG_2026), {
    period: "last_month",
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(resolveDateRange({ period: "last_month" }, new Date(2026, 0, 5)), {
    period: "last_month",
    from: "2025-12-01",
    to: "2025-12-31",
  });
});

test("headlineCompareRange for เดือนที่แล้ว compares the full previous month", () => {
  const range = headlineCompareRange(
    { period: "last_month", from: "2026-07-01", to: "2026-07-31" },
    "2026-08-11",
  );
  assert.deepEqual(range, { from: "2026-06-01", to: "2026-06-30", elapsed_days: 31 });
});

test("likeForLikePair compares MTD to the same elapsed days last month", () => {
  const pair = likeForLikePair("2026-08-11", "month", "2026-08-11");
  assert.deepEqual(pair.latest, { from: "2026-08-01", to: "2026-08-11" });
  assert.deepEqual(pair.baseline, { from: "2026-07-01", to: "2026-07-11" });
  assert.equal(pair.elapsed_days, 11);
});

test("weeksOfMonth counts only Sundays that fall in the month", () => {
  const aug = weeksOfMonth(2026, 8);
  assert.equal(aug[0].from, "2026-08-02");
  assert.equal(aug[0].to, "2026-08-08");
  assert.equal(aug[1].from, "2026-08-09");
  assert.equal(aug[1].week_of_month, 2);
  const jul = weeksOfMonth(2026, 7);
  assert.equal(jul[jul.length - 1].from, "2026-07-26");
  assert.equal(jul[jul.length - 1].week_of_month, 4);
});

test("resolveRollingMonthWeeks keeps 4 slots spanning prior month", () => {
  const window = resolveRollingMonthWeeks(
    { month: "2026-08", week: 2 },
    TUE_11_AUG_2026,
  );
  assert.equal(window.weeks.length, 4);
  assert.deepEqual(
    window.weeks.map((w) => w.from),
    ["2026-07-19", "2026-07-26", "2026-08-02", "2026-08-09"],
  );
  assert.deepEqual(
    window.weeks.map((w) => w.short_label),
    ["W3 M.7", "W4 M.7", "W1 M.8", "W2 M.8"],
  );
  assert.equal(window.weeks[3].current, true);
});
