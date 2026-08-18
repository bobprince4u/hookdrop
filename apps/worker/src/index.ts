import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import type { Worker } from 'bullmq'
import { env } from './config/env'
import { initDB, AppDataSource } from './db'
import { closeQueues } from './queue'
import { startDeliveryWorker } from './workers/delivery.worker'
import { startEmailWorker } from './workers/email.worker'
import {
  startSubscriptionScheduler,
  stopSubscriptionScheduler,
} from './schedulers/subscription.scheduler'
import {
  startRetentionScheduler,
  stopRetentionScheduler,
} from './schedulers/retention.scheduler'

/**
 * Configuration is validated at import time by `./config/env`, replacing four separate
 * `dotenv.config({ path: '../../.env' })` calls resolved against `process.cwd()` (H-44).
 */
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  // Was a hardcoded 1.0 (H-43).
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
})

const workers: Worker[] = []

const start = async (): Promise<void> => {
  await initDB()
  workers.push(startDeliveryWorker(), startEmailWorker())
  startSubscriptionScheduler()
  startRetentionScheduler()
  console.log(`Hookdrop worker service running (${env.NODE_ENV})`)
}

/**
 * Graceful shutdown.
 *
 * `worker.close()` waits for in-flight jobs to finish before returning, which is what stops
 * a redeploy from killing a delivery mid-request. Without it the job stayed marked active
 * until the stalled-job check reclaimed it, delaying that delivery by up to a full
 * `stalledInterval` — and the process previously kept no reference to either worker, so
 * there was nothing to close.
 */
let shuttingDown = false

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`Received ${signal}, draining workers`)

  const timer = setTimeout(() => {
    console.error('Shutdown timed out after 30s, exiting')
    process.exit(1)
  }, 30_000)
  timer.unref()

  try {
    stopSubscriptionScheduler()
    stopRetentionScheduler()
    await Promise.allSettled(workers.map((worker) => worker.close()))
    await closeQueues()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    clearTimeout(timer)
    console.log('Worker service stopped cleanly')
    process.exit(0)
  } catch (error) {
    console.error(
      'Error during shutdown:',
      error instanceof Error ? error.message : 'unknown error'
    )
    process.exit(1)
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

/**
 * `start()` was called with no `.catch`, so a failed database connection became an
 * unhandled rejection and the process stayed alive with no workers consuming anything.
 */
start().catch((error: unknown) => {
  console.error(
    'Failed to start worker service:',
    error instanceof Error ? error.message : 'unknown error'
  )
  process.exit(1)
})
