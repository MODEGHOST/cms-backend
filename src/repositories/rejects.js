/** Placeholder repository for reject_records */
export function createRejectRepository(pool) {
  return {
    async list() {
      const [rows] = await pool.query("SELECT 1 AS ok");
      return rows;
    },
  };
}
