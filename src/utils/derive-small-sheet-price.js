function toNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPrice(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** แปลงราคา Sales Line (UOM เช่น แผ่น*2) → ราคา/แผ่นเล็ก */
export function deriveSmallSheetPriceFromErp(erpRow) {
  if (!erpRow || typeof erpRow !== "object") return null;

  const salesUnitPrice = toNumber(erpRow.sales_unit_price);
  const uomQtyPer = toNumber(erpRow.uom_qty_per);
  const lineAmount = toNumber(erpRow.line_amount);
  const demandQty = toNumber(erpRow.demand_qty);
  const apiPrice = toNumber(erpRow.price_per_sheet);

  if (salesUnitPrice != null && uomQtyPer != null && uomQtyPer > 0) {
    return roundPrice(salesUnitPrice / uomQtyPer);
  }

  const uomText = String(erpRow.unit_of_measure || "").trim();
  const uomMatch =
    uomText.match(/(?:แผ่น\s*)?\*\s*(\d+(?:\.\d+)?)/i) ||
    uomText.match(/\*\s*(\d+(?:\.\d+)?)/);
  if (salesUnitPrice != null && uomMatch) {
    const mult = Number(uomMatch[1]);
    if (Number.isFinite(mult) && mult > 0) {
      return roundPrice(salesUnitPrice / mult);
    }
  }

  if (
    lineAmount != null &&
    lineAmount > 0 &&
    demandQty != null &&
    demandQty > 0
  ) {
    return roundPrice(lineAmount / demandQty);
  }

  if (
    apiPrice != null &&
    salesUnitPrice != null &&
    uomQtyPer != null &&
    uomQtyPer > 1 &&
    Math.abs(apiPrice - salesUnitPrice) < 0.0001
  ) {
    return roundPrice(salesUnitPrice / uomQtyPer);
  }

  return apiPrice;
}

export function normalizeErpPdrRow(row) {
  if (!row || typeof row !== "object") return row;
  const price = deriveSmallSheetPriceFromErp(row);
  if (price == null) return row;
  return { ...row, price_per_sheet: price };
}
