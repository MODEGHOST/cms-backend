/**
 * ข้อมูล ERP จำลองสำหรับทดสอบ local (ไม่ต้องมี PHP / MSSQL)
 * เปิดด้วย ERP_DEV_FIXTURE=1 ใน cms-backend/.env
 *
 * price_per_sheet = ราคา Sales Line ก่อนแปลง UOM (จำลอง API เก่า)
 * frontend/backend ต้อง derive → 19.76 บาท/แผ่นเล็ก
 */
const FIXTURES = {
  "PDR2608-09389": {
    pdr_no: "PDR2608-09389",
    sale_order_no: "SO2608-0389",
    company_name: "(fixture) ลูกค้าทดสอบ UOM",
    customer_alias_name: "ทดสอบ UOM",
    customer_ship_date: "2026-08-15",
    production_date: "2026-08-14",
    machine_name: "CORRUGATOR-01",
    shift: "A",
    flute_name: "B",
    product_name: "กล่องลูกฟูก (fixture UOM แผ่น*2)",
    demand_qty: 520,
    sales_unit_price: 39.52,
    uom_qty_per: 2,
    unit_of_measure: "แผ่น*2",
    line_amount: 20550.4,
    price_per_sheet: 39.52,
    weight_per_sheet: 0.81119,
    t: 2,
    item_no: "FIXTURE-ITEM",
    big_sheet: 260,
    big_sheet_size: "410x2191",
    small_sheet_size: "205x2191",
  },
};

export function getErpDevFixture(pdrNo) {
  const key = String(pdrNo || "")
    .trim()
    .toUpperCase();
  if (!key) return null;
  const row = FIXTURES[key];
  return row ? { ...row } : null;
}

export function listErpDevFixturePdrs() {
  return Object.keys(FIXTURES);
}
