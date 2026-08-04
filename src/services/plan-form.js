export const PLAN_CONTRIBUTOR_DEFAULT = 2;
export const PLAN_CONTRIBUTOR_MAX = 10;

export const PDF_IMAGE_SLOTS = [
  { value: "picture", label: "Picture (รูปภาพ)" },
  { value: "cause", label: "Root cause (สาเหตุ)" },
  { value: "correction", label: "Corrective Action (แก้ไข)" },
  { value: "prevention", label: "Preventive Action (แนวทางป้องกัน)" },
  { value: "none", label: "ไม่ใส่ใน PDF" },
];

export const PDF_IMAGE_SLOT_KEYS = ["picture", "cause", "correction", "prevention"];

export const PLAN_APPROVAL_ROLES = [
  {
    key: "production_specialist",
    label: "ผู้เชี่ยวชาญการผลิต",
    field: "plan_sig_approval_production",
  },
  {
    key: "qa_deputy",
    label: "รองผู้จัดการฝ่ายประกันคุณภาพ",
    field: "plan_sig_approval_qa",
  },
];

function emptyContributor() {
  return { name: "", position: "", signatureId: null };
}

function normalizePdfImageSlots(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const allowed = new Set([...PDF_IMAGE_SLOT_KEYS, "none"]);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id <= 0) continue;
    const slot = String(value || "").trim();
    if (!allowed.has(slot)) continue;
    out[String(id)] = slot;
  }
  return out;
}

export function emptyPlanForm(count = PLAN_CONTRIBUTOR_DEFAULT) {
  const size = Math.min(
    PLAN_CONTRIBUTOR_MAX,
    Math.max(1, Number(count) || PLAN_CONTRIBUTOR_DEFAULT),
  );
  return {
    contributors: Array.from({ length: size }, () => emptyContributor()),
    approvals: {
      production_specialist: { signatureId: null },
      qa_deputy: { signatureId: null },
    },
    pdfImageSlots: {},
  };
}

export function normalizePlanForm(raw) {
  const base = emptyPlanForm();
  if (!raw) return base;

  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return base;
    }
  }
  if (!parsed || typeof parsed !== "object") return base;

  const incomingRows = Array.isArray(parsed.contributors) ? parsed.contributors : [];
  const mapped = incomingRows
    .slice(0, PLAN_CONTRIBUTOR_MAX)
    .map((incoming) => {
      const signatureId = Number(incoming?.signatureId || incoming?.signature_id || 0);
      return {
        name: String(incoming?.name || "").trim(),
        position: String(incoming?.position || "").trim(),
        signatureId: Number.isInteger(signatureId) && signatureId > 0 ? signatureId : null,
      };
    });

  base.contributors =
    mapped.length > 0
      ? mapped
      : Array.from({ length: PLAN_CONTRIBUTOR_DEFAULT }, () => emptyContributor());

  const approvals = parsed.approvals || {};
  for (const role of PLAN_APPROVAL_ROLES) {
    const incoming = approvals[role.key] || {};
    const signatureId = Number(incoming.signatureId || incoming.signature_id || 0);
    base.approvals[role.key] = {
      signatureId: Number.isInteger(signatureId) && signatureId > 0 ? signatureId : null,
    };
  }

  base.pdfImageSlots = normalizePdfImageSlots(
    parsed.pdfImageSlots || parsed.pdf_image_slots,
  );
  return base;
}

/**
 * Group image attachments into PDF slots.
 * If no slots configured yet, all images default to Picture (backward compatible).
 */
export function groupImagesByPdfSlot(imageAttachments = [], planForm = null) {
  const slots = planForm?.pdfImageSlots || {};
  const hasMapping = Object.keys(slots).length > 0;
  const grouped = {
    picture: [],
    cause: [],
    correction: [],
    prevention: [],
  };

  for (const attachment of imageAttachments || []) {
    const id = Number(attachment?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const mapped = slots[String(id)] || slots[id];
    if (hasMapping) {
      if (mapped && grouped[mapped]) grouped[mapped].push(attachment);
    } else {
      grouped.picture.push(attachment);
    }
  }

  for (const key of PDF_IMAGE_SLOT_KEYS) {
    grouped[key] = grouped[key].slice(0, 3);
  }
  return grouped;
}

/** Collect signature attachment ids currently referenced by the plan form. */
export function collectPlanSignatureIds(planForm) {
  const ids = [];
  for (const row of planForm?.contributors || []) {
    if (row.signatureId) ids.push(Number(row.signatureId));
  }
  for (const role of PLAN_APPROVAL_ROLES) {
    const id = planForm?.approvals?.[role.key]?.signatureId;
    if (id) ids.push(Number(id));
  }
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}
