import { PgBoss } from 'pg-boss'
import { env, isProduction } from '../config/env'
import { ALL_QUEUES, consumerBossOptions } from './contract'

/**
 * The worker's pg-boss instance and its lifecycle.
 *
 * This is the only place in the system that constructs a *consuming* instance, and the
 * only place that is allowed to install or migrate the queue schema, register queues, or
 * run the maintenance and cron loops. The two producers publish and nothing else.
 *
 * Replaces `../queue.ts`, which held a Redis connection, two BullMQ `Queue` objects and
 * shared `defaultJobOptions`. None of that has an equivalent here: the queue is Postgres,
 * so it uses the database connection this service already needs, and retention is a
 * property of the queue definitions in `./contract`. This service no longer talks to Redis
 * at all.
 */

let instance: PgBoss | null = null

/**
 * Constructs the instance, installs or migrates the queue schema, and registers every
 * queue.
 *
 * Registration is idempotent — `createQueue` on an existing queue updates its options —
 * so this runs on every boot and is how a change to a retry limit in `./contract` reaches
 * the database. It is also what lets the producers refuse to start until the worker has
 * been deployed once: they check for these queues and do not create them.
 */
export const startQueue = async (): Promise<PgBoss> => {
  if (instance) return instance

  const boss = new PgBoss(
    consumerBossOptions({
      databaseUrl: env.DATABASE_URL,
      isProduction,
      applicationName: 'hookdrop-worker-queue',
      poolMax: env.PGBOSS_POOL_MAX,
    })
  )

  /**
   * pg-boss is an EventEmitter, and an unhandled `error` event terminates the process.
   * Losing the worker because a maintenance query timed out is not an improvement on
   * logging it, so this is attached before `start()`.
   *
   * Only the message is logged. The error object can carry the connection string, which
   * contains the database password (H-48).
   */
  boss.on('error', (error: Error) => {
    console.error('Worker queue error:', error.message)
  })

  await boss.start()

  for (const queue of ALL_QUEUES) {
    const { name, ...options } = queue
    await boss.createQueue(name, options)
  }

  console.log(
    `Worker: queue ready (schema ${await boss.schemaVersion()}, queues: ${ALL_QUEUES.map(
      (q) => q.name
    ).join(', ')})`
  )

  instance = boss
  return boss
}

/** The started instance. Throws rather than lazily starting a second one. */
export const getBoss = (): PgBoss => {
  if (!instance) {
    throw new Error('Queue accessed before startQueue()')
  }
  return instance
}

/**
 * Stops accepting jobs, drains what is in flight within `timeoutMs`, then closes the pool.
 *
 * One call covers three of the shutdown steps because pg-boss does them in order: it stops
 * every worker fetching, waits for active handlers while polling, and only then closes.
 * Anything still running when the timeout expires is marked failed, which returns it to
 * the queue for a later attempt rather than dropping it — the same guarantee that covers a
 * worker killed without warning.
 */
export const stopQueue = async (timeoutMs: number): Promise<void> => {
  if (!instance) return

  const boss = instance
  instance = null

  await boss.stop({ graceful: true, timeout: timeoutMs, close: true })
}
