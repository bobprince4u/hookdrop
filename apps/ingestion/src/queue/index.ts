import { Queue, JobsOptions } from 'bullmq'
import IORedis, { RedisOptions } from 'ioredis'
import { env, redisTlsOptions } from '../config/env'

/**
 * Redis connections and queue registry for the ingestion service.
 *
 * Three things were wrong here, and the first one made the other two invisible:
 *
 * 1. `process.env.REDIS_URL || 'redis://localhost:6379'` — combined with the
 *    `dotenv.config({ path: '../../.env' })` above it, which only resolved when the
 *    process was started from `apps/ingestion` (H-44), a hosted deployment silently
 *    connected to a local Redis that does not exist. Events were accepted, written to
 *    Postgres, and never queued. The URL is now required configuration (H-09).
 * 2. No TLS for `rediss://`, so a managed Redis would refuse the connection outright.
 * 3. No retention on completed or failed jobs, so the instance grew without bound (H-38).
 *
 * The `ai` queue registration is gone (H-04): nothing ever consumed it, and AI insights
 * are generated on demand and cached in `ai.controller.ts`, so the producer was redundant
 * rather than merely unconsumed. Draining any jobs already enqueued is an operational
 * step, documented in `docs/hardening.md` — not something this code does on boot.
 */

const connectionOptions = (): RedisOptions => ({
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  ...redisTlsOptions(),
})

/**
 * A named connection.
 *
 * Socket.IO's Redis adapter needs its own pair: the subscriber goes into subscriber mode,
 * where Redis rejects ordinary commands, so it cannot be the connection BullMQ is using
 * to enqueue jobs. The `role` is only used to label errors — without it, three
 * connections report failures indistinguishably.
 */
export const createRedisConnection = (role: string): IORedis => {
  const connection = new IORedis(env.REDIS_URL, connectionOptions())

  connection.on('error', (error: Error) => {
    // Otherwise the first symptom is deliveries quietly not happening.
    console.error(`Ingestion Redis (${role}) error:`, error.message)
  })

  return connection
}

export const redis = createRedisConnection('queue')

/**
 * Bounded retention for every queue, matching the API's settings so the two producers
 * cannot disagree about how long a job's record survives.
 */
export const defaultJobOptions: JobsOptions = {
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
}

export const deliveryQueue = new Queue('delivery', {
  connection: redis,
  defaultJobOptions,
})

export const closeQueues = async (): Promise<void> => {
  await Promise.allSettled([deliveryQueue.close()])
  await redis.quit()
}
