/**
 * Parse ยอดส่งจริง into small-sheet quantity.
 * - "4100" / 4100 → 4100 (already small sheets)
 * - "250*3" / "1,995*5" → product (large sheets × cut factor)
 */
export function parseShipQty(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let text = String(value).replace(/,/g, "").replace(/\s+/g, "").trim();
  if (!text || text === "-") return null;

  text = text.replace(/[x×X]/g, "*");

  const product = text.match(/^(\d+(?:\.\d+)?)\*(\d+(?:\.\d+)?)$/);
  if (product) {
    const left = Number(product[1]);
    const right = Number(product[2]);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
    return left * right;
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}
