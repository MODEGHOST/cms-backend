/**
 * Ensure Center_user_lfb has telegram_chat_id for Bot DM delivery.
 */
export async function ensureTelegramChatId(conn, {
  sharedDbName = "shared_auth",
  centerUserTable = "Center_user_lfb",
} = {}) {
  const table = `\`${sharedDbName}\`.\`${centerUserTable}\``;
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'telegram_chat_id'`,
    [sharedDbName, centerUserTable],
  );
  if (cols.length) return false;

  await conn.query(`
    ALTER TABLE ${table}
      ADD COLUMN telegram_chat_id VARCHAR(64) NULL AFTER telegram_id,
      ADD UNIQUE KEY uq_center_user_telegram_chat (telegram_chat_id)
  `);
  return true;
}
