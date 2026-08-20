import type { PgBoss, JobWithMetadata } from 'pg-boss'
import { env } from '../config/env'
import {
  QUEUES,
  type DeliveryJob,
  type EmailJob,
  type ScheduledJob,
} from './contract'
import { processDelivery } from '../processors/delivery.processor'
import { processEmail } from '../processors/email.processor'
import {
  enforceRetention,
  RETENTION_CRON,
} from '../schedulers/retention.scheduler'
import {
  checkExpiringSubscriptions,
  cleanupDemoEvents,
  SUBSCRIPTION_EXPIRY_CRON,
  DEMO_CLEANUP_CRON,
} from '../schedulers/subscription.scheduler'

/**
 * Job consumption: every handler this service runs, and every schedule it owns.
 *
 * This replaces `workers/delivery.worker.ts` and `workers/email.worker.ts` — two BullMQ
 * `Worker` objects, each with its own Redis connection, stall detection and event listeners
 * — and the `node-cron` registrations inside the two scheduler modules. One place now knows
 * what is consumed, at what concurrency, and on what schedule.
 *
 * Only the worker registers handlers. The API and ingestion services publish and nothing
 * else, which is enforced by their pg-boss instances being constructed with `supervise` and
 * `schedule` off (see `producerBossOptions` in `./contract`).
 */

/**
 * Reduces anything a handler throws to a plain `Error` carrying only its message.
 *
 * This is required rather than tidy. pg-boss stores the thrown value in the job's `output`
 * column — a durable row in the same database as customer data, retained for two weeks by
 * default — where BullMQ kept the failure in memory and in Redis. Several errors reachable
 * from these handlers serialise far more than their message:
 *
 *   - an axios error carries its own `config`, which for a delivery includes the request
 *     headers and therefore the destination's HMAC signature;
 *   - a Resend transport error carries `Authorization: Bearer <RESEND_API_KEY>`;
 *   - a TypeORM `QueryFailedError` carries the failing SQL and its bound parameters.
 *
 * None of that may be persisted (H-48). The delivery processor and the email processor
 * already throw messages they composed themselves, so for them this is a no-op; the point is
 * that an *unanticipated* throw cannot leak either.
 *
 * The stack is carried over deliberately — it is function names and file paths, which are
 * useful and are not secrets.
 */
const sanitize = (error: unknown): Error => {
  if (!(error instanceof Error)) return new Error('Unknown handler error')

  const sanitized = new Error(error.message)
  sanitized.name = error.name
  sanitized.stack = error.stack
  return sanitized
}

/**
 * Wraps a per-job processor as a pg-boss batch handler.
 *
 * Handlers receive an array because pg-boss can fetch several jobs per poll. `batchSize` is
 * left at its default of 1 for every queue here, so each array holds one job and a throw
 * only ever affects the job that caused it. The loop is written to be correct regardless: if
 * a batch size were ever raised, a failure would fail the whole batch and every job in it
 * would be retried — which the delivery processor tolerates, because a retried delivery
 * skips destinations that already reached a terminal state.
 *
 * The failure is logged here, once, with the run counter, and then re-thrown so pg-boss
 * schedules the retry. Nothing else in the process listens for job failures — the two
 * BullMQ `worker.on('failed')` listeners this replaces existed only to log the message
 * rather than the error object, which `sanitize` now guarantees for the stored copy too.
 */
const guarded =
  <T>(label: string, handle: (job: JobWithMetadata<T>) => Promise<void>) =>
  async (jobs: JobWithMetadata<T>[]): Promise<void> => {
    for (const job of jobs) {
      try {
        await handle(job)
      } catch (error) {
        console.error(
          `${label} job ${job.id} failed on run ${job.retryCount + 1}/${
            job.retryLimit + 1
          }:`,
          error instanceof Error ? error.message : 'unknown error'
        )
        throw sanitize(error)
      }
    }
  }

/**
 * Delivery.
 *
 * `localConcurrency` is the per-process bound, replacing BullMQ's `concurrency`. It is the
 * outer of two limits: within one job the processor still delivers to an endpoint's
 * destinations strictly sequentially, so a fan-out of 50 destinations is 50 requests in
 * series, not 50 at once. Nothing here makes that parallel — pg-boss making concurrency
 * easy is not a reason to start hammering destinations, and the per-destination attempt
 * counter and the retry semantics both assume one attempt at a time.
 *
 * `groupConcurrency: 1` is the third limit and the important one for correctness. Jobs are
 * published with `group: { id: eventId }`, and this makes pg-boss track group membership in
 * the database, so no two jobs for the *same event* run at the same time anywhere in the
 * cluster — not just within this process. That is what stops a replay enqueued while the
 * original job is still active from racing it into a double delivery, and it holds across
 * replicas, which is where an in-memory guard would have failed.
 *
 * `includeMetadata` is what populates `retryCount` and `retryLimit`, which the processor
 * needs to recognise its final run and resolve delivery rows rather than strand them.
 */
const deliveryWorkOptions = {
  includeMetadata: true,
  localConcurrency: env.DELIVERY_CONCURRENCY,
  groupConcurrency: 1,
} as const

const emailWorkOptions = {
  includeMetadata: true,
  localConcurrency: env.EMAIL_CONCURRENCY,
} as const

/**
 * Cron-triggered sweeps run one at a time. `policy: 'exclusive'` on these queues already
 * guarantees a single job queued or active, so this only states the local intent.
 */
const sweepWorkOptions = {
  includeMetadata: true,
  localConcurrency: 1,
} as const

export const registerHandlers = async (boss: PgBoss): Promise<void> => {
  await boss.work<DeliveryJob, void, typeof deliveryWorkOptions>(
    QUEUES.delivery,
    deliveryWorkOptions,
    guarded('Delivery', processDelivery)
  )

  await boss.work<EmailJob, void, typeof emailWorkOptions>(
    QUEUES.email,
    emailWorkOptions,
    guarded('Email', processEmail)
  )

  await boss.work<ScheduledJob, void, typeof sweepWorkOptions>(
    QUEUES.retention,
    sweepWorkOptions,
    guarded('Retention', () => enforceRetention())
  )

  await boss.work<ScheduledJob, void, typeof sweepWorkOptions>(
    QUEUES.subscriptionExpiry,
    sweepWorkOptions,
    guarded('Subscription expiry', async () => {
      console.log('Running subscription expiry check')
      await checkExpiringSubscriptions()
    })
  )

  await boss.work<ScheduledJob, void, typeof sweepWorkOptions>(
    QUEUES.demoCleanup,
    sweepWorkOptions,
    guarded('Demo cleanup', () => cleanupDemoEvents())
  )

  console.log(
    `Worker: handlers registered (delivery concurrency ${env.DELIVERY_CONCURRENCY}, ` +
      `email concurrency ${env.EMAIL_CONCURRENCY})`
  )
}

/**
 * Registers the three recurring schedules.
 *
 * `schedule` is an upsert on queue name, so running this on every boot is how a change to a
 * cron expression or to `SCHEDULER_TIMEZONE` reaches the database. The timezone is passed
 * explicitly, exactly as it was to `node-cron`, so "9am" is one specific instant rather than
 * whatever the host clock is set to.
 *
 * `RETENTION_ENABLED=false` now has to *remove* the schedule, not merely decline to register
 * it. Under `node-cron` the registration lived in the process, so not registering it was
 * sufficient; a pg-boss schedule is a row that survives the restart, so a flag flipped off
 * would otherwise keep enqueueing retention jobs for ever. `enforceRetention` also returns
 * early on the flag, so a job already queued when the flag flips does nothing — the two
 * checks are deliberate belt and braces around the one job here that destroys customer data.
 */
export const registerSchedules = async (boss: PgBoss): Promise<void> => {
  const tz = env.SCHEDULER_TIMEZONE

  if (env.RETENTION_ENABLED) {
    await boss.schedule(QUEUES.retention, RETENTION_CRON, null, { tz })
  } else {
    // A DELETE of nothing, so this is safe whether or not a schedule was ever created.
    await boss.unschedule(QUEUES.retention)
    console.warn(
      'RETENTION_ENABLED is false; per-plan event retention is NOT being enforced, ' +
        'and any existing retention schedule has been removed from the queue.'
    )
  }

  await boss.schedule(
    QUEUES.subscriptionExpiry,
    SUBSCRIPTION_EXPIRY_CRON,
    null,
    { tz }
  )
  await boss.schedule(QUEUES.demoCleanup, DEMO_CLEANUP_CRON, null, { tz })

  console.log(
    `Worker: schedules registered (timezone ${tz}) — ` +
      `retention ${env.RETENTION_ENABLED ? RETENTION_CRON : 'disabled'}, ` +
      `subscription-expiry ${SUBSCRIPTION_EXPIRY_CRON}, ` +
      `demo-cleanup ${DEMO_CLEANUP_CRON}`
  )
}
