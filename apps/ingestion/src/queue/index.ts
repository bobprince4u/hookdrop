import { PgBoss } from 'pg-boss'
import { env, isProduction } from '../config/env'
import { QUEUES, assertQueuesExist, producerBossOptions } from './contract'

/**
 * The ingestion service's pg-boss instance: publish only.
 *
 * Replaces a module that owned a Redis connection, a BullMQ `Queue` and shared
 * `defaultJobOptions`. The Redis connection moved to `../redis`, which still has three real
 * consumers (Socket.IO, the rate limiter, the quota cache); the queue moved to Postgres.
 *
 * ## What this service is allowed to do
 *
 * Publish, and nothing else. `producerBossOptions` switches off `migrate`, `createSchema`,
 * `supervise` and `schedule`, so this instance cannot install or alter the queue schema and
 * does not run the maintenance or cron loops — those belong to `apps/worker`, which is the
 * single owner of the queue. Left at their defaults, every ingestion replica would run a
 * second copy of the maintenance loop and a second cron ticker.
 *
 * Because `migrate` is off, `boss.start()` runs the schema *check* rather than the
 * installer: if the pg-boss schema is missing or is a version this client does not
 * understand, startup fails here instead of at the first webhook. `assertQueuesExist` then
 * covers what the check does not — the individual queue this service sends to. Together they
 * turn "webhook accepted, job silently unqueueable" into "this replica refuses to boot",
 * which is how this codebase already treats invalid configuration.
 *
 * ## Retry options are not set here
 *
 * Delivery retry limits, backoff, expiry and retention are properties of the *queue*, and
 * the queue is defined once in `./contract` and registered by the worker. Under BullMQ every
 * producer restated `attempts: 4` and a backoff policy on every `add()` call, in three
 * places, and nothing kept them in step.
 */

let instance: PgBoss | null = null

/** Queues this service publishes to. Checked at boot, not created. */
const PUBLISHES_TO = [QUEUES.delivery] as const

export const startQueue = async (): Promise<PgBoss> => {
  if (instance) return instance

  const boss = new PgBoss(
    producerBossOptions({
      databaseUrl: env.DATABASE_URL,
      isProduction,
      applicationName: 'hookdrop-ingestion-queue',
    })
  )

  /**
   * pg-boss is an EventEmitter, and an unhandled `error` event terminates the process.
   * Attached before `start()`.
   *
   * The message only: the error object can carry the connection string, which contains the
   * database password (H-48).
   */
  boss.on('error', (error: Error) => {
    console.error('Ingestion queue error:', error.message)
  })

  await boss.start()
  await assertQueuesExist(boss, PUBLISHES_TO)

  console.log(
    `Ingestion: queue ready (schema ${await boss.schemaVersion()}, publishing to: ${PUBLISHES_TO.join(
      ', '
    )})`
  )

  instance = boss
  return boss
}

/**
 * The started instance.
 *
 * Throws rather than lazily starting one. A publisher constructed on demand inside a request
 * would open a second pool per replica and would skip the boot-time checks above, which is
 * the failure this is here to prevent.
 */
export const getBoss = (): PgBoss => {
  if (!instance) {
    throw new Error('Queue accessed before startQueue()')
  }
  return instance
}

/**
 * Closes the pg-boss pool on shutdown.
 *
 * Nothing to drain — this instance runs no handlers — so this only stops the queue-metadata
 * cache timer and closes the connections. It must run *before* the TypeORM `DataSource` is
 * destroyed only in the sense that both must happen; they share no connections, because a
 * transactional publish borrows the caller's TypeORM connection rather than one of these.
 */
export const closeQueue = async (timeoutMs = 5_000): Promise<void> => {
  if (!instance) return

  const boss = instance
  instance = null

  await boss.stop({ graceful: true, timeout: timeoutMs, close: true })
}
