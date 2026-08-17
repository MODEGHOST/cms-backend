/** Parse / display helpers for multi-select ปัญหา on Complaint and Reject. */

function normalizeNameList(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    const out = [];
    const seen = new Set();
    for (const item of value) {
      for (const name of normalizeNameList(item)) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
      }
    }
    return out;
  }
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      return normalizeNameList(JSON.parse(trimmed));
    } catch {
      /* fall through */
    }
  }
  if (trimmed.includes(" · ")) {
    return normalizeNameList(trimmed.split(" · "));
  }
  return [trimmed];
}

/**
 * @returns {string[] | null} names when the payload includes problem fields; null if omitted
 */
export function parseProblemNames(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (
    Object.prototype.hasOwnProperty.call(payload, "problem_names") &&
    payload.problem_names != null
  ) {
    return normalizeNameList(payload.problem_names);
  }
  if (payload.problem_names_json != null && payload.problem_names_json !== "") {
    return namesFromJson(payload.problem_names_json);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "problem_name")) {
    const value = payload.problem_name;
    if (Array.isArray(value)) return normalizeNameList(value);
    if (value == null || String(value).trim() === "") return [];
    return [String(value).trim()];
  }
  return null;
}

export function joinProblemNames(names) {
  return (names || []).map((name) => String(name || "").trim()).filter(Boolean).join(" · ");
}

export function problemNamesOf(record) {
  const fromNames = normalizeNameList(record?.problem_names);
  if (fromNames.length) return fromNames;
  if (Array.isArray(record?.problems) && record.problems.length) {
    return normalizeNameList(record.problems.map((row) => row?.name));
  }
  const fromJson = namesFromJson(record?.problem_names_json);
  if (fromJson.length) return fromJson;
  return normalizeNameList(record?.problem_name);
}

export function mergeRelatedRejects(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  const problems = [];
  const seen = new Set();
  for (const row of list) {
    const items =
      Array.isArray(row.problems) && row.problems.length
        ? row.problems
        : problemNamesOf(row).map((name) => ({ id: null, name, name_en: null }));
    for (const item of items) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      const key = item.id ? `id:${item.id}` : `name:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({
        id: item.id || null,
        name,
        name_en: item.name_en || null,
      });
    }
  }
  return applyProblemsToRecord(list[0], problems);
}

export function formatProblemLabel(record) {
  return joinProblemNames(problemNamesOf(record));
}

export function formatProblemNameEn(record) {
  const ens = (record?.problems || [])
    .map((row) => String(row?.name_en || "").trim())
    .filter(Boolean);
  if (ens.length) return ens.join(" · ");
  return String(record?.problem_name_en || "").trim();
}

export function namesFromJson(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return normalizeNameList(raw);
  try {
    return normalizeNameList(JSON.parse(String(raw)));
  } catch {
    return [];
  }
}

export function applyProblemsToRecord(record, problems) {
  if (!record) return record;
  let list = Array.isArray(problems) ? problems : [];
  const jsonNames = namesFromJson(record.problem_names_json);
  if (jsonNames.length > list.length) {
    const byName = new Map(list.map((row) => [String(row.name || "").toLowerCase(), row]));
    list = jsonNames.map((name) => {
      const existing = byName.get(name.toLowerCase());
      return existing || { id: null, name, name_en: null };
    });
  }
  const names = list.map((row) => row.name).filter(Boolean);
  const namesEn = list.map((row) => row.name_en).filter(Boolean);
  if (!list.length && (record.problem_id || record.problem_name)) {
    const fallbackNames = normalizeNameList(record.problem_name);
    const fallback = fallbackNames.length
      ? fallbackNames.map((name, index) => ({
          id: index === 0 ? record.problem_id || null : null,
          name,
          name_en: index === 0 ? record.problem_name_en || null : null,
        }))
      : [
          {
            id: record.problem_id || null,
            name: record.problem_name || null,
            name_en: record.problem_name_en || null,
          },
        ].filter((row) => row.id || row.name);
    return applyProblemsToRecord(
      { ...record, problem_names_json: null },
      fallback,
    );
  }
  const { problem_names_json: _omit, ...rest } = record;
  return {
    ...rest,
    problems: list,
    problem_names: names,
    problem_id: list[0]?.id ?? record.problem_id ?? null,
    problem_name: joinProblemNames(names) || record.problem_name || null,
    problem_name_en: namesEn.join(" · ") || record.problem_name_en || null,
  };
}
