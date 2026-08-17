export async function ensurePasswordResetTokens(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      telegram_chat_id VARCHAR(64) NULL,
      telegram_message_id BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_password_reset_hash (token_hash),
      KEY idx_password_reset_user (user_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'password_reset_tokens'
       AND COLUMN_NAME IN ('telegram_chat_id', 'telegram_message_id')`,
  );
  const have = new Set(cols.map((c) => c.COLUMN_NAME));

  if (!have.has("telegram_chat_id")) {
    await conn.query(`
      ALTER TABLE password_reset_tokens
        ADD COLUMN telegram_chat_id VARCHAR(64) NULL AFTER used_at
    `);
  }
  if (!have.has("telegram_message_id")) {
    await conn.query(`
      ALTER TABLE password_reset_tokens
        ADD COLUMN telegram_message_id BIGINT NULL AFTER telegram_chat_id
    `);
  }
}
