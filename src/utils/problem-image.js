import { publicApiPath } from "../core/config.js";

export function problemImageUrl(problemId) {
  const id = Number(problemId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return publicApiPath(`/api/masters/problems/${id}/image`);
}

export function enrichProblemRow(row) {
  if (!row) return row;
  return {
    ...row,
    has_image: Boolean(row.image_file),
    image_url: row.image_file ? problemImageUrl(row.id) : null,
  };
}

export function mapFocusProblems(items, limit = 3) {
  return (items || []).slice(0, limit).map((item) => {
    if (typeof item === "string") {
      return { name: item, image_url: null };
    }
    return {
      id: item.id,
      name: item.name,
      image_url: item.image_file ? problemImageUrl(item.id) : item.image_url || null,
    };
  });
}
