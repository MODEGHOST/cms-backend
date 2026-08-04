import {
  canCsWork,
  canDepartmentWork,
  canQaWork,
  isCmsAdmin,
} from "../core/authz.js";

export const COMPLAINT_WORKFLOW_LABELS = {
  cs_draft: "รอ CS",
  pending_qa: "รอ QA รับเรื่อง",
  qa_review: "รอ QA",
  pending_department: "รอหน่วยงานรับเรื่อง",
  department_action: "หน่วยงานกำลังดำเนินการ",
  qa_confirm: "รอ QA Confirm",
  completed: "เสร็จสิ้น",
};

/**
 * Build WHERE for role-scoped complaint inbox (items waiting on this user).
 * Uses OR across CS / QA / department scopes when a user has multiple permissions.
 */
export function buildComplaintInboxFilter(user) {
  if (isCmsAdmin(user)) {
    return {
      whereSql: `cr.workflow_status <> 'completed'`,
      params: [],
      empty: false,
    };
  }

  const parts = [];
  const params = [];

  if (canCsWork(user)) {
    parts.push(`cr.workflow_status = 'cs_draft'`);
  }
  if (canQaWork(user)) {
    parts.push(`cr.workflow_status IN ('pending_qa', 'qa_review', 'qa_confirm')`);
  }
  if (canDepartmentWork(user)) {
    const department = String(user?.department || "").trim();
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
    whereSql: `(${parts.join(" OR ")})`,
    params,
    empty: false,
  };
}
