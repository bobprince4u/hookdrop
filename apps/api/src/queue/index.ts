import { PgBoss } from 'pg-boss'
import { env, isProduction } from '../config/env'
import { QUEUES, assertQueuesExist, producerBossOptions } from './contract'

/**
 * The API's pg-boss instance: publish only.
 *
 * Replaces a module that owned a Redis connection and two BullMQ `Queue` objects. The Redis
 * connection moved to `../redis`, which still backs the Socket.IO adapter and every rate
 * limiter; the queues moved to Postgres.
 *
 * The API publishes to two queues, for the two things it starts: `replayEvent` re-queues
 * delivery work for an existing event, and `sendWelcomeSequence` schedules the two
 * onboarding emails. Both are described in `./contract`.
 *
 * ## What this service is allowed to do
 *
 * Publish, and nothing else. `producerBossOptions` switches off `migrate`, `createSchema`,
 * `supervise` and `schedule`, so this instance cannot install or alter the queue schema and
 * does not run the maintenance or cron loops — those belong to `apps/worker`, the single
 * owner of the queue. Left at their defaults, every API replica would run its own copy of
 * both, and the cron ticker in particular would mean N replicas racing to enqueue the same
 * scheduled sweep.
 *
 * Because `migrate` is off, `boss.start()` runs the schema *check* rather than the installer:
 * a missing or unrecognised schema version fails startup here rather than at the first
 * replay. `assertQueuesExist` then covers what the check does not — the individual queues
 * this service sends to.
 *
 * ## Retry options are not set here
 *
 * Retry limits, backoff, expiry and retention are properties of the *queue*, defined once in
 * `./contract` and registered by the worker. Under BullMQ each producer restated
 * `attempts: 4` and a backoff policy on every `add()` call, in three separate modules, with
 * nothing keeping them in step.
 */

let instance: PgBoss | null = null

/** Queues this service publishes to. Checked at boot, not created. */
const PUBLISHES_TO = [QUEUES.delivery, QUEUES.email] as const

export const startQueue = async (): Promise<PgBoss> => {
  if (instance) return instance

  const boss = new PgBoss(
    producerBossOptions({
      databaseUrl: env.DATABASE_URL,
      isProduction,
      applicationName: 'hookdrop-api-queue',
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
    console.error('API queue error:', error.message)
  })

  await boss.start()
  await assertQueuesExist(boss, PUBLISHES_TO)

  console.log(
    `API: queue ready (schema ${await boss.schemaVersion()}, publishing to: ${PUBLISHES_TO.join(
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
 * would open a second pool per replica and skip the boot-time checks above — which is the
 * failure this exists to prevent.
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
 * Nothing to drain — this instance runs no handlers — so this stops the queue-metadata cache
 * timer and closes the connections. It shares no connections with TypeORM: a transactional
 * publish borrows the caller's TypeORM connection rather than one of these.
 */
export const closeQueue = async (timeoutMs = 5_000): Promise<void> => {
  if (!instance) return

  const boss = instance
  instance = null

  await boss.stop({ graceful: true, timeout: timeoutMs, close: true })
}
