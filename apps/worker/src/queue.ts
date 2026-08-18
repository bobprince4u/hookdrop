import { Queue, JobsOptions } from 'bullmq'
import IORedis, { RedisOptions } from 'ioredis'
import { env, redisTlsOptions } from './config/env'

/**
 * Redis connection and queue registry for the worker.
 *
 * Previously `new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', …)` with a
 * cwd-relative dotenv above it (H-44), so in a hosted deployment this service connected to
 * a local Redis that does not exist and consumed nothing — while reporting itself started
 * (H-09). The URL is now required configuration validated at import.
 *
 * The `tls` handling is also corrected. It was written as
 * `tls: url?.startsWith('rediss://') ? {} : undefined`, which sets the key to `undefined`
 * rather than omitting it — harmless with ioredis today, but it depends on how the option
 * is inspected. Spreading a conditional object omits the key outright.
 *
 * Retention is new (H-38): nothing removed completed or failed jobs, so the instance grew
 * without bound.
 */

const connectionOptions = (): RedisOptions => ({
  // BullMQ requires this to be null on connections used by a Worker.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  ...redisTlsOptions(),
})

export const createRedisConnection = (role: string): IORedis => {
  const connection = new IORedis(env.REDIS_URL, connectionOptions())

  connection.on('error', (error: Error) => {
    // Otherwise the first symptom is jobs silently piling up with no consumer.
    console.error(`Worker Redis (${role}) error:`, error.message)
  })

  return connection
}

export const redis = createRedisConnection('queue')

/** Matches the API and ingestion settings so no producer disagrees about retention. */
export const defaultJobOptions: JobsOptions = {
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
}

export const deliveryQueue = new Queue('delivery', {
  connection: redis,
  defaultJobOptions,
})

export const emailQueue = new Queue('email', {
  connection: redis,
  defaultJobOptions,
})

export const closeQueues = async (): Promise<void> => {
  await Promise.allSettled([deliveryQueue.close(), emailQueue.close()])
  await redis.quit()
}
