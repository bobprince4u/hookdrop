import './env'

import { all, count, one } from './database'
import { startQueue, stopQueue } from '../../apps/worker/src/queue'
import { PGBOSS_SCHEMA, QUEUES } from '../../apps/worker/src/queue/contract'
import type { QueueName } from '../../apps/worker/src/queue/contract'

/**
 * Queue lifecycle and inspection for the suites.
 *
 * The worker's own `startQueue()` is used rather than a fresh `new PgBoss(...)`, because the
 * thing under test includes the registration step: `startQueue` installs the schema, then
 * calls `createQueue` for every entry in `ALL_QUEUES`, and the retry policy those calls
 * write is what the retry tests then depend on. A test that constructed its own instance
 * would be asserting against options it had just chosen itself.
 *
 * It also means the suites fail if the producers' `assertQueuesExist` precondition would
 * fail in production — the queues either exist after `startQueue()` or they do not.
 */

/** `pgboss.job.state`, as the `pgboss.job_state` enum defines it. */
export type JobState =
  | 'created'
  | 'retry'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'failed'

/**
 * The columns the suites assert on.
 *
 * `group_id` is where `send`'s `group: { id }` lands — not `singleton_key`, which is the
 * older single-active-job mechanism. It matters because `group_id` plus the consumer's
 * `groupConcurrency: 1` is the guard against two workers running two jobs for the same
 * event, so a test for that scenario reads this column.
 */
export interface JobRow<T = unknown> {
  id: string
  name: string
  state: JobState
  retry_count: number
  retry_limit: number
  policy: string | null
  group_id: string | null
  data: T
  output: unknown
  start_after: Date
  started_on: Date | null
  completed_on: Date | null
}

const JOB_COLUMNS = `id, name, state, retry_count, retry_limit, policy, group_id,
                     data, output, start_after, started_on, completed_on`

/**
 * Starts the queue for a suite. Idempotent, so `before` hooks can call it freely.
 *
 * Returns the boss so a test can publish through the real `publishDelivery` /
 * `publishEmail` helpers, which take the instance as their first argument.
 */
export const startTestQueue = async () => startQueue()

/**
 * A short drain window. Any handler still running is marked failed and returned to the
 * queue, so nothing is lost by not waiting long — and a suite that hangs for the
 * production-length timeout on every file is a suite nobody runs.
 */
const TEST_DRAIN_MS = 2_000

export const stopTestQueue = async (): Promise<void> => stopQueue(TEST_DRAIN_MS)

/**
 * Job rows for one queue, oldest first, in every state.
 *
 * Read with SQL rather than `boss.getJobById`, for the same reason the fixtures are SQL: the
 * question these suites ask is whether a row is *in the table* — the transactional publish
 * test turns entirely on that — and pg-boss's own accessors would answer a slightly
 * different question through a second connection with its own visibility.
 */
export const jobsOn = async <T = unknown>(
  queue: QueueName
): Promise<JobRow<T>[]> =>
  all<JobRow<T>>(
    `select ${JOB_COLUMNS}
       from ${PGBOSS_SCHEMA}.job
      where name = $1
      order by created_on asc, id asc`,
    [queue]
  )

export const jobCountOn = async (queue: QueueName): Promise<number> =>
  count(
    `select count(*)::text as n from ${PGBOSS_SCHEMA}.job where name = $1`,
    [queue]
  )

/**
 * Exactly one job on `queue`, or a failure that says how many there were instead.
 *
 * Most assertions in these suites are of the form "one job, with this payload"; without the
 * count in the message a drift to two jobs reads as a payload mismatch on the first one.
 */
export const onlyJobOn = async <T = unknown>(
  queue: QueueName
): Promise<JobRow<T>> => {
  const rows = await jobsOn<T>(queue)
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one job on "${queue}", found ${rows.length}` +
        (rows.length > 1
          ? ` (states: ${rows.map((r) => r.state).join(', ')})`
          : '')
    )
  }
  return rows[0] as JobRow<T>
}

/**
 * The retry and expiry settings pg-boss actually stored for a queue.
 *
 * The contract declares them and `createQueue` writes them, but nothing between the two is
 * checked at runtime — a policy the database never received would only show up as a retry
 * that did not happen, hours later. This reads the registry back.
 */
export interface QueueRegistration {
  name: string
  policy: string
  retry_limit: number
  retry_delay: number
  retry_backoff: boolean
  retry_delay_max: number | null
  expire_seconds: number
}

export const registrationOf = async (
  queue: QueueName
): Promise<QueueRegistration | undefined> =>
  one<QueueRegistration>(
    `select name, policy, retry_limit, retry_delay, retry_backoff,
            retry_delay_max, expire_seconds
       from ${PGBOSS_SCHEMA}.queue
      where name = $1`,
    [queue]
  )

export { QUEUES }
