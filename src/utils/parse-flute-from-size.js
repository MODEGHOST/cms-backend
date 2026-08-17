/**
 * ดึงรหัสลอนจากท้ายช่อง Size / Description
 * เช่น "54x24 KS170/CA125/CA125 B" → "B"
 *     "52 x 48 7/8 KT250/3CA185/KT250 BC" → "BC"
 */
const FLUTE_FROM_SIZE_RE = /\b(AB|BC|A|B|C|E)\s*$/i;

export function parseFluteFromSize(size) {
  const text = String(size || "").trim();
  if (!text) return null;
  const match = text.match(FLUTE_FROM_SIZE_RE);
  return match ? match[1].toUpperCase() : null;
}
