export function parsePagination(query = {}, { maxPageSize = 100 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const cap = Math.max(1, Number(maxPageSize) || 100);
  const pageSize = Math.min(cap, Math.max(1, Number(query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

export function paginatedJson(rows, total, { page, pageSize }) {
  return {
    data: rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
    },
  };
}

export function toDateOnly(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, 10);
}
