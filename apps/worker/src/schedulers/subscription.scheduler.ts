import { LessThan, Not } from 'typeorm'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { env } from '../config/env'
import {
  sendSubscriptionReminderEmail,
  sendExpiredEmail,
} from '../services/email.service'

/**
 * Subscription lifecycle scheduler (H-10).
 *
 * Three defects, in descending order of consequence:
 *
 * 1. **The date range was not a range.** Both reminder queries were written
 *    `plan_expires_at: MoreThan(start) && LessThan(end)`. `&&` is a JavaScript operator,
 *    not a query combinator: it evaluates `MoreThan(start)` — a truthy object — and
 *    discards it, yielding only `LessThan(end)`. So the "expiring in 7 days" query matched
 *    every user whose plan expires before that day, including ones that expired months
 *    ago, and the 3-day query matched an overlapping superset. Every run mailed the same
 *    users repeatedly. `Between` is the combinator that was meant.
 *
 * 2. **The hourly demo cleanup ran at module import.** `cron.schedule(...)` sat at the
 *    bottom of the file at top level, so importing this module for any reason registered a
 *    recurring `DELETE`. There is no `cron.schedule` call left to be careless with — see
 *    the note on scheduling below.
 *
 * 3. **`plan_expires_at: undefined` never cleared the column.** TypeORM omits `undefined`
 *    properties from the generated `UPDATE`, so downgraded users kept a stale past expiry
 *    forever. `null` is what clears it.
 *
 * 4. **Nothing recorded that a reminder had been sent.** `last_reminder_sent_at` existed on
 *    the entity with no column behind it, so the latch it was meant to provide could not be
 *    written without throwing. `migrations/1787011380000_add-users-reminder-tracking.js` adds
 *    it, and `sendRemindersForDay` now claims it per user — see the comment there for why one
 *    timestamp is enough to distinguish the 7-day reminder from the 3-day one.
 *
 * Defect 2 no longer has a `cron.schedule` call to be careless with: this module is only the
 * *body* of two jobs now, and `queue/handlers.ts` registers both schedules with pg-boss.
 * Importing this file has no side effects at all, which is a stronger version of the same
 * fix — and the schedules are cluster-wide, so the hourly `DELETE` runs once per tick rather
 * than once per replica.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Reminders are sent this many days before expiry. */
const REMINDER_DAYS = [7, 3] as const

/**
 * Daily, at 09:00 in `SCHEDULER_TIMEZONE`. The timezone is explicit so "9am" is one
 * specific instant rather than whatever the host's clock happens to be set to.
 */
export const SUBSCRIPTION_EXPIRY_CRON = '0 9 * * *'

/** Hourly. `RETENTION_CRON` is deliberately offset from this — see that constant. */
export const DEMO_CLEANUP_CRON = '0 * * * *'

/**
 * The UTC day containing `instant`.
 *
 * Deliberately UTC rather than `setHours(0,0,0,0)`, which used the server's local
 * timezone: the same query returned different users depending on where the process ran,
 * and near a DST transition the window was 23 or 25 hours long (the same class of defect
 * as H-21's month boundary).
 */
const utcDayBounds = (instant: Date): { start: Date; end: Date } => {
  const start = new Date(
    Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate(),
      0,
      0,
      0,
      0
    )
  )
  const end = new Date(start.getTime() + DAY_MS - 1)
  return { start, end }
}

const sendRemindersForDay = async (daysAhead: number): Promise<void> => {
  const userRepo = AppDataSource.getRepository(User)
  const { start, end } = utcDayBounds(new Date(Date.now() + daysAhead * DAY_MS))

  /**
   * The latch (H-10).
   *
   * One nullable timestamp distinguishes both reminders without a second column, because
   * each reminder's window opens at a different instant: the 7-day notice is due at
   * `plan_expires_at - 7 days`, the 3-day notice at `plan_expires_at - 3 days`. A user is
   * owed this reminder only if the last one went out *before* this window opened.
   *
   *  - re-run on the same day → `last_reminder_sent_at` is now inside the window, so nothing
   *    is re-sent, which is the defect this fixes;
   *  - the 3-day notice still sends, because the 7-day notice was stamped four days before
   *    the 3-day window opened;
   *  - a renewal needs no cleanup: pushing `plan_expires_at` forward moves both windows past
   *    the stale stamp, so the next period's reminders are owed again automatically.
   *
   * Expressed against the row's own expiry rather than a precomputed instant, so it stays
   * exact for every user in the batch instead of assuming they all expire at the same
   * moment.
   */
  const users = await userRepo
    .createQueryBuilder('user')
    .where('user.plan != :free', { free: 'free' })
    .andWhere('user.plan_expires_at BETWEEN :start AND :end', { start, end })
    .andWhere(
      `(user.last_reminder_sent_at IS NULL
        OR user.last_reminder_sent_at < user.plan_expires_at - ((:daysAhead)::int * INTERVAL '1 day'))`,
      { daysAhead }
    )
    .getMany()

  for (const user of users) {
    // Narrowing for the type checker; a BETWEEN cannot match NULL.
    if (!user.plan_expires_at) continue

    try {
      await sendSubscriptionReminderEmail(
        user.email,
        user.name,
        user.plan,
        daysAhead,
        user.plan_expires_at
      )

      /**
       * Stamped only after the send resolves. Stamping first would make a transient Resend
       * failure look like a delivered reminder and suppress every retry for the rest of the
       * window — the opposite failure to the one being fixed, and the worse of the two.
       */
      await userRepo.update(user.id, { last_reminder_sent_at: new Date() })

      console.log(`${daysAhead}-day reminder sent to user ${user.id}`)
    } catch (error) {
      /**
       * Per-user isolation. One failing address previously aborted the whole run through
       * the outer catch, so every later user in the list — and both subsequent stages —
       * were skipped for that day.
       *
       * The id is logged rather than the address: scheduler output is not the place to
       * accumulate a list of customer emails (H-48).
       */
      console.error(
        `Failed to send ${daysAhead}-day reminder to user ${user.id}:`,
        error instanceof Error ? error.message : 'unknown error'
      )
    }
  }
}

const downgradeExpiredUsers = async (): Promise<void> => {
  const userRepo = AppDataSource.getRepository(User)

  /**
   * Filtered in SQL, not in JavaScript. The previous version loaded every user whose
   * expiry was in the past — including all the already-downgraded ones, forever — and
   * then skipped them with an `if` after the fact.
   */
  const expired = await userRepo.find({
    where: {
      plan: Not('free'),
      plan_expires_at: LessThan(new Date()),
    },
  })

  for (const user of expired) {
    // Captured before the update: the email tells the user which plan lapsed.
    const previousPlan = user.plan

    try {
      await userRepo.update(user.id, {
        plan: 'free',
        // `undefined` here left the stale expiry in place.
        plan_expires_at: null,
        /**
         * Cleared with the plan. The latch keys off `plan_expires_at`, so a stale stamp
         * would not actually suppress a future period's reminders — but leaving a
         * "reminder sent" timestamp on an account that no longer has a subscription makes
         * the row's state ambiguous to read, and this is the one place that knows the
         * subscription has ended.
         */
        last_reminder_sent_at: null,
      })
      console.log(`User ${user.id} downgraded to free — ${previousPlan} expired`)

      await sendExpiredEmail(user.email, user.name, previousPlan)
    } catch (error) {
      console.error(
        `Failed to downgrade user ${user.id}:`,
        error instanceof Error ? error.message : 'unknown error'
      )
    }
  }
}

export const checkExpiringSubscriptions = async (): Promise<void> => {
  try {
    for (const days of REMINDER_DAYS) {
      await sendRemindersForDay(days)
    }
    await downgradeExpiredUsers()
  } catch (error) {
    console.error(
      'Subscription scheduler error:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

export const cleanupDemoEvents = async (): Promise<void> => {
  try {
    /**
     * Parameterised, and the endpoint id and window come from configuration rather than
     * being literals inside the SQL string.
     *
     * The count comes from `RETURNING` inside a data-modifying CTE rather than from the
     * driver's affected-rows reporting: what `AppDataSource.query()` returns for a bare
     * `DELETE` differs between TypeORM versions, and a log line that quietly reports nothing
     * is worse than one that reports a number it actually counted. `retention.scheduler.ts`
     * uses the same shape, where the count is load-bearing rather than cosmetic.
     */
    const rows: unknown = await AppDataSource.query(
      `WITH removed AS (
         DELETE FROM events
         WHERE endpoint_id = $1
           AND received_at < NOW() - ($2 || ' hours')::interval
         RETURNING 1
       )
       SELECT count(*)::int AS deleted FROM removed`,
      [env.DEMO_ENDPOINT_ID, String(env.DEMO_RETENTION_HOURS)]
    )

    const reported = Array.isArray(rows)
      ? (rows[0] as { deleted?: unknown } | undefined)?.deleted
      : undefined
    const deleted = Number(reported)
    console.log(
      `Demo events cleaned up${Number.isFinite(deleted) ? ` (${deleted} removed)` : ''}`
    )
  } catch (error) {
    console.error(
      'Demo cleanup error:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}
