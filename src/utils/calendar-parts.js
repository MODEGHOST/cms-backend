/** Auto week / month from complaint received_date (ISO week). */

export function calendarPartsFromDate(value) {
  if (value == null || value === "") return { week_no: null, month_no: null };
  const raw = value instanceof Date ? value : new Date(String(value).slice(0, 10));
  if (Number.isNaN(raw.getTime())) return { week_no: null, month_no: null };

  const month_no = raw.getMonth() + 1;

  // ISO week number
  const date = new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week_no = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return { week_no, month_no };
}
