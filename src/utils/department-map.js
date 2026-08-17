/**
 * Canonical department master names + legacy aliases from old Excel data.
 * Always run Excel / form department labels through canonicalizeDepartmentName
 * before resolving to departments.id so "CRM" → "MKT", etc.
 */

/** Active master list (List Department.xlsx + รอเคลียร์) */
export const CANONICAL_DEPARTMENTS = [
  "ENG",
  "FG",
  "HR",
  "IQC",
  "LAB",
  "LTS",
  "MA",
  "MKT",
  "PD",
  "PKG",
  "PLAN",
  "PU",
  "QA",
  "QC",
  "RM",
  "SALE",
  "WH",
  "รอเคลียร์",
];

/**
 * Old / alternate labels → canonical master name.
 * Keys must be output of normalizeDepartmentKey().
 */
export const DEPARTMENT_LEGACY_MAP = {
  // --- user mapping ---
  crm: "MKT",
  cs: "MKT",
  "customer service": "MKT",
  customerservice: "MKT",
  en: "ENG",
  eng: "ENG",
  lts: "LTS",
  mkt: "MKT",
  packing: "PKG",
  pack: "PKG",
  pkg: "PKG",
  pd: "PD",
  plan: "PLAN",
  planning: "PLAN",
  production: "PD",
  prod: "PD",
  qa: "QA",
  qc: "QC",
  ตลาด: "MKT",
  "ผลิต qc": "PD",
  ผลิตqc: "PD",
  pdqc: "PD",
  "pd qc": "PD",
  รอเคลียร์: "รอเคลียร์",
  วางแผน: "PLAN",
  customer: "MKT",
  "production qa": "PD",
  "production,qa": "PD",
  "pd,qa": "PD",
  "qa,pd": "PD",

  // --- canonical self (any casing / spacing) ---
  fg: "FG",
  hr: "HR",
  iqc: "IQC",
  lab: "LAB",
  ma: "MA",
  pu: "PU",
  rm: "RM",
  sale: "SALE",
  sales: "SALE",
  wh: "WH",
  warehouse: "WH",
};

export function normalizeDepartmentKey(value) {
  return String(value || "")
    .trim()
    .replace(/[_\-/|]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Map legacy Excel department label → canonical master name.
 * Returns null for empty. Unknown labels returned trimmed (caller decides).
 */
export function canonicalizeDepartmentName(value) {
  if (value == null) return null;
  const clean = String(value).replace(/\s+/g, " ").trim();
  if (!clean || clean === "-" || clean.toLowerCase() === "null") return null;

  const key = normalizeDepartmentKey(clean);
  const mapped = DEPARTMENT_LEGACY_MAP[key];
  if (mapped) return mapped;

  // Match canonical by case-insensitive key (e.g. "mkt" already covered; "Mkt")
  const hit = CANONICAL_DEPARTMENTS.find(
    (name) => normalizeDepartmentKey(name) === key,
  );
  if (hit) return hit;

  // Excel sometimes joins departments: "Production,QA" / "PD/QA"
  if (/[,/+&]/.test(clean)) {
    const parts = clean
      .split(/[,/+&]/)
      .map((part) => canonicalizeDepartmentName(part))
      .filter(Boolean);
    const unique = [...new Set(parts)];
    // Prefer first mappable canonical part
    const canonicalPart = unique.find((name) =>
      CANONICAL_DEPARTMENTS.some(
        (item) => normalizeDepartmentKey(item) === normalizeDepartmentKey(name),
      ),
    );
    if (canonicalPart) return canonicalPart;
  }

  return clean;
}

/** True when name is one of the official master departments. */
export function isCanonicalDepartment(name) {
  const canonical = canonicalizeDepartmentName(name);
  if (!canonical) return false;
  return CANONICAL_DEPARTMENTS.some(
    (item) => normalizeDepartmentKey(item) === normalizeDepartmentKey(canonical),
  );
}
