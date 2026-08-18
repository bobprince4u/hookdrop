import { Queue, JobsOptions } from 'bullmq'
import IORedis from 'ioredis'
import { env, redisTlsOptions } from '../config/env'

/**
 * Single Redis connection and queue registry for the API.
 *
 * Replaces two modules that both claimed the name `../queue`: a directory module
 * that read `REDIS_URL`, and a sibling `queue.ts` holding `new IORedis()` with no
 * arguments. Node resolves `../queue` to the file before the directory, so the
 * argument-less one was the live code path for outbound email — silently pointing
 * at localhost in every environment (H-09). The URL is now required
 * configuration, and `rediss://` gets TLS here too, not only in the worker (H-38).
 */
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  ...redisTlsOptions(),
})

redis.on('error', (error: Error) => {
  // Connection errors are otherwise swallowed until a job silently piles up.
  console.error('API Redis connection error:', error.message)
})

/**
 * Bounded retention for every queue.
 *
 * Nothing previously removed completed or failed jobs, so Redis grew without
 * limit (H-38).
 */
export const defaultJobOptions: JobsOptions = {
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
}

export const deliveryQueue = new Queue('delivery', {
  connection: redis,
  defaultJobOptions,
})

/**
 * The `ai` queue registration is gone (H-04).
 *
 * Nothing anywhere consumed it — there was no `ai` worker in `apps/worker` — while
 * `apps/ingestion` enqueued a job to it for every single inbound event. AI insights are
 * generated on demand and cached by `getOrCreateInsight`, so the queue was redundant
 * rather than merely unconsumed, and removing the producer is the honest fix.
 *
 * Jobs already sitting in Redis from before this change are not touched here. Draining
 * them is an operational step, documented in `docs/hardening.md`, because deleting a queue
 * is destructive and belongs in the operator's hands, not in a module that runs on boot.
 */
export const emailQueue = new Queue('email', {
  connection: redis,
  defaultJobOptions,
})

export const closeQueues = async (): Promise<void> => {
  await Promise.allSettled([deliveryQueue.close(), emailQueue.close()])
  await redis.quit()
}
