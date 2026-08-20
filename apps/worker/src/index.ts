import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import { env } from './config/env'
import { initDB, AppDataSource } from './db'
import { startQueue, stopQueue } from './queue'
import { registerHandlers, registerSchedules } from './queue/handlers'

/**
 * Worker entrypoint.
 *
 * Configuration is validated at import time by `./config/env`, replacing four separate
 * `dotenv.config({ path: '../../.env' })` calls resolved against `process.cwd()` (H-44). An
 * invalid value exits here rather than surfacing as a job that never runs.
 */
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  // Was a hardcoded 1.0 (H-43).
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
})

/**
 * Total budget for shutdown, and the share of it the queue may spend draining.
 *
 * The drain finishes first by design: the outer watchdog exists only for the case where
 * something below it hangs, and it exits non-zero because a shutdown that had to be killed
 * is not a clean one. The gap between the two leaves room to close the database pool.
 */
const SHUTDOWN_TIMEOUT_MS = 30_000
const DRAIN_TIMEOUT_MS = 20_000

/**
 * Startup order matters and is not incidental.
 *
 * The database connection comes first because every handler needs it. The queue is started
 * before any handler is registered — `startQueue` installs or migrates the pg-boss schema
 * and registers the queue definitions, and a handler on a queue that does not exist yet
 * would throw. Schedules come last: they enqueue work, so nothing should be scheduled until
 * there is something able to consume it.
 *
 * This is also the only process that does any of that. The API and ingestion services
 * construct publish-only instances that neither migrate the schema nor run the maintenance
 * and cron loops, so a queue definition or a schedule has exactly one owner.
 */
const start = async (): Promise<void> => {
  await initDB()

  const boss = await startQueue()
  await registerHandlers(boss)
  await registerSchedules(boss)

  console.log(`Hookdrop worker service running (${env.NODE_ENV})`)
}

/**
 * Graceful shutdown.
 *
 * `stopQueue` is three of the steps in one call, in this order: stop every worker fetching
 * new jobs, wait for the handlers already running, then close the pool. Anything still
 * running when the drain budget expires is marked failed rather than abandoned, so it
 * returns to the queue for a later attempt — the same guarantee that covers a worker killed
 * without warning, which is now `expireInSeconds` on the queue rather than BullMQ's stalled-
 * job check.
 *
 * The database connection is closed after the queue, not before: a handler still finishing
 * during the drain is writing delivery state, and pulling the pool out from under it would
 * turn a completed delivery into a failed job.
 */
let shuttingDown = false

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true

  console.log(`Received ${signal}, draining jobs`)

  const timer = setTimeout(() => {
    console.error(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, exiting`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref()

  try {
    await stopQueue(DRAIN_TIMEOUT_MS)
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
