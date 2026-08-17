/**
 * Map member department → workflow permission codes.
 * Used when hydrating staff users (Role grants base reads; dept grants work).
 */
import {
  CANONICAL_DEPARTMENTS,
  canonicalizeDepartmentName,
  normalizeDepartmentKey,
} from "./department-map.js";

/** Read-only base shared by staff / viewer roles. */
export const STAFF_BASE_PERMISSIONS = [
  "rejects.read",
  "complaints.read",
  "masters.read",
  "dashboard.read",
  "activity.read",
];

/** Departments that work the CS complaint step. */
const CS_DEPARTMENTS = new Set(["MKT", "SALE"]);

/**
 * Workflow permissions granted by canonical department name.
 * Unknown / empty → none (staff keeps base reads only).
 */
export function permissionsForDepartment(department) {
  const canonical = canonicalizeDepartmentName(department);
  if (!canonical) return [];

  const key = normalizeDepartmentKey(canonical);
  const hit = CANONICAL_DEPARTMENTS.find(
    (name) => normalizeDepartmentKey(name) === key,
  );
  const name = hit || canonical;

  if (CS_DEPARTMENTS.has(name)) return ["complaints.cs"];
  if (name === "QA") return ["complaints.qa"];
  if (name === "QC") return ["rejects.update"];

  // Other master departments (PD, ENG, …) handle department step.
  if (hit) return ["complaints.department"];
  return [];
}

/** Departments that can accept/process the department complaint step (document P). */
export function canHandleDepartmentStep(department) {
  return permissionsForDepartment(department).includes("complaints.department");
}

/**
 * Merge role permissions with department-derived workflow permissions.
 * Only `staff` gets department extras (admin/developer already have all).
 */
export function mergeStaffPermissions(roleNames, rolePermissions, department) {
  const roles = roleNames || [];
  const base = [...(rolePermissions || [])];
  if (!roles.includes("staff")) {
    return [...new Set(base)].sort();
  }
  const extra = permissionsForDepartment(department);
  return [...new Set([...base, ...extra])].sort();
}

/** Default department when migrating a legacy workflow role (if profile dept empty). */
export function defaultDepartmentForLegacyRole(legacyRoleName) {
  const name = String(legacyRoleName || "").trim().toLowerCase();
  if (name === "cs") return "MKT";
  if (name === "qa") return "QA";
  if (name === "qc") return "QC";
  return null;
}

/**
 * Pick default department when user had multiple legacy workflow roles
 * and profile department is empty. Priority: QA > QC > MKT.
 */
export function pickDefaultDepartmentFromLegacyRoles(legacyRoleNames) {
  const set = new Set(
    (legacyRoleNames || []).map((r) => String(r || "").trim().toLowerCase()),
  );
  if (set.has("qa")) return "QA";
  if (set.has("qc")) return "QC";
  if (set.has("cs")) return "MKT";
  return null;
}

/** Legacy workflow role names retired in favor of staff + department. */
export const LEGACY_WORKFLOW_ROLES = ["cs", "qa", "qc", "department"];

/** Departments notified for "CS" audience (Telegram / lookups). */
export const CS_AUDIENCE_DEPARTMENTS = ["MKT", "SALE"];

export const WORKFLOW_PERMISSION_LABELS = {
  "complaints.cs": "งาน Complaint ขั้น CS",
  "complaints.qa": "งาน Complaint ขั้น QA",
  "complaints.department": "รับเรื่อง/กรอกตามหน่วยงานที่รับผิดชอบ",
  "rejects.update": "แก้ไข Reject (QC)",
};

/**
 * Full matrix for admin UI: every canonical department → work permissions.
 */
export function listDepartmentWorkMatrix() {
  return CANONICAL_DEPARTMENTS.map((department) => {
    const permissions = permissionsForDepartment(department);
    return {
      department,
      permissions,
      labels: permissions.map(
        (code) => WORKFLOW_PERMISSION_LABELS[code] || code,
      ),
      work_summary:
        permissions.length === 0
          ? "อ่านอย่างเดียว (ยังไม่มีสิทธิ์งาน)"
          : permissions
              .map((code) => WORKFLOW_PERMISSION_LABELS[code] || code)
              .join(" · "),
    };
  });
}