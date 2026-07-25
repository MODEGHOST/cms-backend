export function createUserRepository(pool) {
  return {
    async findByUsername(username) {
      const [rows] = await pool.query(
        `SELECT id, username, password_hash, display_name, role, is_active
         FROM users
         WHERE username = ?
         LIMIT 1`,
        [username],
      );
      return rows[0] || null;
    },

    async findById(id) {
      const [rows] = await pool.query(
        `SELECT id, username, display_name, role, is_active
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [id],
      );
      return rows[0] || null;
    },

    async countAll() {
      const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM users");
      return Number(count);
    },

    async create({ username, passwordHash, displayName, role = "staff" }) {
      const [result] = await pool.query(
        `INSERT INTO users (username, password_hash, display_name, role)
         VALUES (?, ?, ?, ?)`,
        [username, passwordHash, displayName, role],
      );
      return result.insertId;
    },
  };
}
