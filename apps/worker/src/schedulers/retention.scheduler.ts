import { AppDataSource } from '../db'
import { env } from '../config/env'
import { PLAN_IDS, PLANS, type PlanId } from '../services/plan.service'

/**
 * Per-plan event retention (H-18).
 *
 * `retention_hours` is published on the marketing page, promised in the welcome email
 * ("24hr retention"), and carried in the plan catalogue of all three services — and until
 * this file existed **nothing read it**. Events accumulated forever. The only pruning
 * anywhere was `cleanupDemoEvents`, which covers one hardcoded demo endpoint.
 *
 * Two consequences, and the second is the one that matters. Storage growth is unbounded, so
 * the largest table in the schema grows without limit; but the events table also stores
 * inbound request bodies and — until H-17 closed the write path — inbound request *headers*
 * verbatim, including whatever credentials a sender put in them. A retention promise that is
 * never enforced means the data a customer believes was discarded a day later is in fact
 * still there, in full, indefinitely.
 *
 * ## Deletion is irreversible, so the design is deliberately unclever
 *
 *  - **The stored `plan` column decides retention, not `resolveEffectivePlan`.** Every other
 *    entitlement check in the codebase computes the effective plan so a lapsed subscription
 *    stops granting access the instant it expires. That is right for *access* and wrong here:
 *    it would mean the sweep that runs at 02:25 destroys a paying customer's month of history
 *    because their card expired at 02:00, before any human could notice. Retention follows
 *    the materialised downgrade written by `subscription.scheduler.ts` instead, so the
 *    reduction is visible in the row, is preceded by two reminder emails and an expiry
 *    notice, and can be undone by a renewal before this job ever looks.
 *
 *  - **A run has a bounded blast radius.** `RETENTION_MAX_BATCHES_PER_RUN` caps how much one
 *    sweep can remove. When a large backlog first becomes eligible — the first run after
 *    deploy, or a tier downgrade on a busy account — the deletion is spread across several
 *    hourly runs and each one says in the log that it stopped early. An operator gets hours
 *    to set `RETENTION_ENABLED=false` if something is wrong, rather than discovering it
 *    afterwards.
 *
 *  - **Unknown plan values are never swept.** A `users.plan` outside the catalogue (a
 *    hand-edited row, a tier added to the database before the code) has no retention window
 *    this job is willing to invent, so its events are kept and the value is logged. Keeping
 *    data that should have been deleted is a bill; deleting data on a guess is not
 *    recoverable.
 *
 * ## Mechanics
 *
 *  - `deliveries` and `ai_insights` both declare `event_id … ON DELETE CASCADE` in their
 *    migrations, so removing an event removes its delivery attempts and cached AI insights
 *    with it. Nothing else references `events`.
 *  - Batched with `FOR UPDATE OF e SKIP LOCKED`, so two worker replicas sweeping at once
 *    divide the work instead of blocking on each other's row locks.
 *  - The row count comes from `RETURNING` inside a data-modifying CTE rather than from the
 *    driver's affected-rows reporting, which differs between TypeORM versions. The count is
 *    also the loop's termination condition, so it has to be exact.
 *  - No `ORDER BY`. Sorting the matched set to delete the oldest first would cost a sort of
 *    every eligible row on every batch and buys nothing: the loop runs until the tier is
 *    exhausted or the cap is hit either way.
 *  - Requires `idx_events_endpoint_received` from
 *    `migrations/1787011500000_add-events-endpoint-received-index.js`. Without it this delete
 *    is a sequential scan of the largest table in the schema, once per tier, every hour.
 *
 * ## Scheduling
 *
 * This module is now only the *body* of the job. The schedule itself lives in the queue —
 * `queue/handlers.ts` registers `RETENTION_CRON` with pg-boss and pg-boss enqueues a
 * `retention` job on each tick — because `cron.schedule` ran in every worker process, so
 * every replica started its own sweep on the same tick. They divided the work correctly
 * thanks to `SKIP LOCKED` rather than corrupting anything, but each replica paid for its own
 * `reportUnknownPlans` scan and its own share of the per-run cap, which made the cap mean
 * something different depending on how many replicas happened to be running.
 */

/**
 * Offset from `cleanupDemoEvents`, which runs at `0 * * * *`. Two hourly jobs deleting from
 * the same table on the same tick would contend for the same pages for no reason.
 */
export const RETENTION_CRON = '25 * * * *'

const HOUR_MS = 60 * 60 * 1000

/** The instant before which events on `plan` are no longer retained. */
const retentionCutoff = (plan: PlanId, now: Date = new Date()): Date =>
  new Date(now.getTime() - PLANS[plan].retention_hours * HOUR_MS)

/**
 * Deletes up to `batchSize` expired events for one plan tier and returns how many went.
 *
 * The `LIMIT` sits inside the locking CTE so it bounds the rows *selected* — a `LIMIT` on the
 * delete itself is not valid SQL, and bounding after the fact would still have scanned
 * everything.
 */
const deleteBatch = async (
  plan: PlanId,
  cutoff: Date,
  batchSize: number
): Promise<number> => {
  const rows: unknown = await AppDataSource.query(
    `WITH doomed AS (
       SELECT e.id
       FROM events e
       JOIN endpoints ep ON ep.id = e.endpoint_id
       JOIN users u ON u.id = ep.user_id
       WHERE u.plan = $1
         AND e.received_at < $2
       LIMIT $3
       FOR UPDATE OF e SKIP LOCKED
     ),
     removed AS (
       DELETE FROM events
       WHERE id IN (SELECT id FROM doomed)
       RETURNING 1
     )
     SELECT count(*)::int AS deleted FROM removed`,
    [plan, cutoff, batchSize]
  )

  // `count(*)` is bigint, which node-postgres returns as a string; the `::int` cast above is
  // what makes this a number. Guarded anyway rather than trusted.
  const reported = Array.isArray(rows)
    ? (rows[0] as { deleted?: unknown } | undefined)?.deleted
    : undefined
  const deleted = Number(reported)
  return Number.isFinite(deleted) && deleted >= 0 ? deleted : 0
}

interface SweepResult {
  readonly deleted: number
  /** False when the per-run cap stopped the sweep with work still eligible. */
  readonly exhausted: boolean
}

const sweepPlan = async (plan: PlanId): Promise<SweepResult> => {
  const cutoff = retentionCutoff(plan)
  const batchSize = env.RETENTION_BATCH_SIZE
  let deleted = 0

  for (let batch = 0; batch < env.RETENTION_MAX_BATCHES_PER_RUN; batch += 1) {
    const removed = await deleteBatch(plan, cutoff, batchSize)
    deleted += removed

    // A short batch means the tier ran out of eligible rows. `SKIP LOCKED` can also return
    // short because another replica holds the rows, which is the same answer for this run:
    // there is nothing left here for *us* to do.
    if (removed < batchSize) return { deleted, exhausted: true }
  }

  return { deleted, exhausted: false }
}

/**
 * Logs any `users.plan` value the catalogue does not know about.
 *
 * Cheap — a single scan of the users table, which is orders of magnitude smaller than
 * `events`. Plan identifiers are not secrets, so the values themselves are safe to log
 * (H-48); no user id or address accompanies them.
 */
const reportUnknownPlans = async (): Promise<void> => {
  const rows: unknown = await AppDataSource.query(
    `SELECT DISTINCT plan FROM users WHERE plan <> ALL($1::text[])`,
    [[...PLAN_IDS]]
  )

  if (!Array.isArray(rows) || rows.length === 0) return

  const values = rows
    .map((row) => (row as { plan?: unknown }).plan)
    .filter((value): value is string => typeof value === 'string')

  if (values.length === 0) return

  console.warn(
    `Retention skipped for unrecognised plan value(s): ${values.join(', ')}. ` +
      'Events for these accounts are being kept indefinitely — add the tier to the plan ' +
      'catalogue or correct the column.'
  )
}

export const enforceRetention = async (): Promise<void> => {
  if (!env.RETENTION_ENABLED) return

  try {
    let total = 0
    let truncated = false

    for (const plan of PLAN_IDS) {
      const result = await sweepPlan(plan)
      total += result.deleted
      if (!result.exhausted) truncated = true

      if (result.deleted > 0) {
        console.log(
          `Retention: removed ${result.deleted} events older than ` +
            `${PLANS[plan].retention_hours}h on the ${plan} plan` +
            (result.exhausted ? '' : ' (per-run cap reached, more remain)')
        )
      }
    }

    if (truncated) {
      console.warn(
        `Retention run stopped at the per-run cap ` +
          `(${env.RETENTION_MAX_BATCHES_PER_RUN} × ${env.RETENTION_BATCH_SIZE} rows per ` +
          'plan). Eligible events remain and will be removed by subsequent runs.'
      )
    }

    await reportUnknownPlans()

    if (total === 0) console.log('Retention: nothing to remove')
  } catch (error) {
    /**
     * Swallowed per-run, like every other scheduled job here: a failed sweep must not take
     * the worker process down, and the next hourly run retries from the same state because
     * the work is defined by a cutoff rather than by a cursor.
     *
     * The message only — a query error object carries the failing SQL and its parameters,
     * and this job's parameters include plan identifiers and timestamps today but would
     * include row ids under any future change (H-48).
     */
    console.error(
      'Retention sweep error:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}
