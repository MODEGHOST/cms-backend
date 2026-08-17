import { createUserRepository } from "../repositories/users.js";
import { createTelegramNotifier } from "./telegram-notifier.js";

/** Calendar days allowed after CS/QA choose รับเอกสาร (P). */
export const DOCUMENT_DEADLINE_DAYS = 3;

/**
 * When remaining days <= this, warn the Telegram group (once per day).
 * 1 = warn on the day before deadline and on the deadline day (and overdue).
 */
export const DOCUMENT_DEADLINE_WARN_WITHIN_DAYS = 1;

/**
 * Polls open P-document complaints nearing the 3-day send deadline
 * and notifies the Telegram group.
 */
export function createDocumentDeadlineWatcher({
  pool,
  telegram,
  config,
  logger,
  intervalMs = 30 * 60 * 1000,
}) {
  const users = createUserRepository(pool);
  const notifier = telegram
    ? createTelegramNotifier({ telegram, users, config, logger })
    : null;

  let timer = null;
  let running = false;

  async function findDueComplaints() {
    const [rows] = await pool.query(
      `SELECT
         cr.id,
         cr.pdr_no,
         cr.document_no,
         cr.document_accepted,
         cr.document_accepted_at,
         cr.workflow_status,
         cr.responsible_department_id,
         d.name AS responsible_department_name,
         DATE(cr.document_accepted_at) AS accepted_on,
         DATE_ADD(DATE(cr.document_accepted_at), INTERVAL ? DAY) AS deadline_on,
         DATEDIFF(
           DATE_ADD(DATE(cr.document_accepted_at), INTERVAL ? DAY),
           CURDATE()
         ) AS days_left
       FROM complaint_records cr
       LEFT JOIN departments d ON d.id = cr.responsible_department_id
       WHERE cr.document_accepted = 'P'
         AND cr.document_accepted_at IS NOT NULL
         AND cr.workflow_status <> 'completed'
         AND DATEDIFF(
           DATE_ADD(DATE(cr.document_accepted_at), INTERVAL ? DAY),
           CURDATE()
         ) <= ?
         AND (
           cr.document_deadline_warned_on IS NULL
           OR cr.document_deadline_warned_on < CURDATE()
         )
       ORDER BY days_left ASC, cr.id ASC
       LIMIT 50`,
      [
        DOCUMENT_DEADLINE_DAYS,
        DOCUMENT_DEADLINE_DAYS,
        DOCUMENT_DEADLINE_DAYS,
        DOCUMENT_DEADLINE_WARN_WITHIN_DAYS,
      ],
    );
    return rows;
  }

  async function tick() {
    if (!notifier) return;
    if (running) return;
    running = true;
    try {
      const rows = await findDueComplaints();
      for (const row of rows) {
        try {
          await notifier.onDocumentDeadlineApproaching(row, {
            daysLeft: Number(row.days_left),
            deadlineDate: row.deadline_on,
            acceptedAt: row.accepted_on || row.document_accepted_at,
          });
          await pool.query(
            `UPDATE complaint_records
             SET document_deadline_warned_on = CURDATE()
             WHERE id = ?`,
            [row.id],
          );
          logger?.info("document_deadline.warned", {
            complaintId: row.id,
            pdr: row.pdr_no,
            daysLeft: row.days_left,
          });
        } catch (err) {
          logger?.warn("document_deadline.warn_failed", {
            complaintId: row.id,
            error: err.message,
          });
        }
      }
    } catch (err) {
      logger?.warn("document_deadline.tick_failed", { error: err.message });
    } finally {
      running = false;
    }
  }

  function start() {
    if (!notifier || !config.telegram?.enabled || !config.telegram?.botToken) {
      logger?.info("document_deadline.watcher_disabled", {
        reason: "telegram not enabled",
      });
      return null;
    }
    if (timer) return timer;
    logger?.info("document_deadline.watcher_started", {
      intervalMs,
      deadlineDays: DOCUMENT_DEADLINE_DAYS,
      warnWithinDays: DOCUMENT_DEADLINE_WARN_WITHIN_DAYS,
    });
    tick().catch(() => {});
    timer = setInterval(() => {
      tick().catch(() => {});
    }, intervalMs);
    return timer;
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
