/**
 * Snapshot of unique prod orders used as the Reject/Complaint % denominator.
 * Types: PDC, PDD, PDF, PDO, PDP, PDR, PDS, PDW, PDZ
 * The 02:00 job upserts rows; dashboards only read this table.
 */

const ORDER_TYPE_ENUM =
  "'PDC', 'PDD', 'PDF', 'PDO', 'PDP', 'PDR', 'PDS', 'PDW', 'PDZ'";

export async function ensureOrderDailyCount(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS order_daily_count (
      order_no VARCHAR(80) NOT NULL,
      order_type ENUM(${ORDER_TYPE_ENUM}) NOT NULL,
      shipment_date DATE NOT NULL,
      synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (order_no),
      KEY idx_order_daily_shipment (shipment_date),
      KEY idx_order_daily_type_date (order_type, shipment_date)
    ) ENGINE=InnoDB
  `);

  // ตารางเก่าอาจยังเป็น ENUM('PDR','PDW') — ขยายให้รองรับครบ
  await conn.query(`
    ALTER TABLE order_daily_count
      MODIFY COLUMN order_type ENUM(${ORDER_TYPE_ENUM}) NOT NULL
  `);
}
