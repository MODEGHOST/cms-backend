import {
  canCsWork,
  canDepartmentWork,
  canQaWork,
  isCmsAdmin,
} from "../core/authz.js";
import { canonicalizeDepartmentName } from "../utils/department-map.js";

export const COMPLAINT_WORKFLOW_LABELS = {
  cs_draft: "รอ CS",
  pending_qa: "รอ QA รับเรื่อง",
  qa_review: "รอ QA",
  pending_department: "รอหน่วยงานรับเรื่อง",
  department_action: "หน่วยงานกำลังดำเนินการ",
  qa_confirm: "รอ QA Confirm",
  completed: "เสร็จสิ้น",
};

export const COMPLAINT_KIND_PRODUCT = "product";
export const COMPLAINT_KIND_SERVICE_TRANSPORT = "service_transport";

export const DOCUMENT_SCOPE_INTERNAL = "ภายใน";
export const DOCUMENT_SCOPE_EXTERNAL = "ภายนอก";

/** Normalize query kind; default product for existing Complaint menus. */
export function normalizeComplaintKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === COMPLAINT_KIND_SERVICE_TRANSPORT) {
    return COMPLAINT_KIND_SERVICE_TRANSPORT;
  }
  return COMPLAINT_KIND_PRODUCT;
}

/** Normalize ร้องเรียนภายใน / ร้องเรียนภายนอก (Excel sheet split). */
export function normalizeDocumentScope(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const text = String(value).trim();
  if (text === DOCUMENT_SCOPE_INTERNAL || text === DOCUMENT_SCOPE_EXTERNAL) return text;
  return null;
}

/** SQL fragment: product rows include legacy NULL kind. */
export function complaintKindSql(kind, column = "cr.complaint_kind") {
  const normalized = normalizeComplaintKind(kind);
  if (normalized === COMPLAINT_KIND_SERVICE_TRANSPORT) {
    return {
      sql: `${column} = 'service_transport'`,
      params: [],
    };
  }
  return {
    sql: `(${column} = 'product' OR ${column} IS NULL)`,
    params: [],
  };
}

/**
 * Build WHERE for role-scoped complaint inbox (items waiting on this user).
 * Uses OR across CS / QA / department scopes when a user has multiple permissions.
 * Optional documentScope filters service/transport by ภายใน vs ภายนอก.
 */
export function buildComplaintInboxFilter(user, { kind, documentScope } = {}) {
  const kindFilter = complaintKindSql(kind);
  const scope = normalizeDocumentScope(documentScope);
  const scopeSql = scope ? ` AND cr.document_scope = ?` : "";
  const scopeParams = scope ? [scope] : [];
  const kindPrefix = `${kindFilter.sql}${scopeSql}`;

  if (isCmsAdmin(user)) {
    return {
      whereSql: `${kindPrefix} AND cr.workflow_status <> 'completed'`,
      params: [...kindFilter.params, ...scopeParams],
      empty: false,
    };
  }

  const parts = [];
  const params = [...kindFilter.params, ...scopeParams];

  if (canCsWork(user)) {
    parts.push(`cr.workflow_status = 'cs_draft'`);
  }
  if (canQaWork(user)) {
    parts.push(`cr.workflow_status IN ('pending_qa', 'qa_review', 'qa_confirm')`);
  }
  if (canDepartmentWork(user)) {
    // canonicalize ให้ตรงกับ isResponsibleDepartmentUser (เช่น CRM → MKT)
    const department = canonicalizeDepartmentName(user?.department);
    if (department) {
      parts.push(
        `(cr.workflow_status IN ('pending_department', 'department_action')
          AND UPPER(TRIM(responsible.name)) = UPPER(TRIM(?)))`,
      );
      params.push(department);
    }
  }

  if (!parts.length) {
    return { whereSql: "1 = 0", params: [], empty: true };
  }

  return {
    whereSql: `${kindPrefix} AND (${parts.join(" OR ")})`,
    params,
    empty: false,
  };
}
