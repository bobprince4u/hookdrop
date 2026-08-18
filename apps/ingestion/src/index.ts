import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import express, { NextFunction, Request, Response } from 'express'
import { createServer } from 'http'
import { env } from './config/env'
import { initDB, AppDataSource } from './db'
import ingestRouter from './routes/ingest'
import { createSocketServer, closeSocketServer } from './socket'
import { closeQueues } from './queue'

/**
 * Configuration is validated at import time by `./config/env`, which exits the process if
 * a required variable is missing. That replaces four separate
 * `dotenv.config({ path: '../../.env' })` calls resolving against `process.cwd()` (H-44).
 */
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  /**
   * Was hardcoded to `1.0`, so the highest-volume service of the three was the one
   * tracing every single request in production while the API honoured this variable and
   * defaulted to 0.1 (H-43).
   */
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
})

const app = express()
const httpServer = createServer(app)

/**
 * `trust proxy` must reflect the real number of proxies in front of the service.
 *
 * Unset, `req.ip` is the proxy's address, which is what gets recorded as `source_ip` on
 * every stored event — so every event looked like it came from the load balancer. Set to
 * a blanket `true`, it becomes whatever the client puts in `X-Forwarded-For`. A hop count
 * is the only setting that is correct in both directions (H-19).
 */
app.set('trust proxy', env.TRUST_PROXY_HOPS)

/** Adapter-backed Socket.IO server, so emits reach dashboard clients on the API (H-12). */
createSocketServer(httpServer)

/**
 * Inbound webhooks are captured as text, unparsed.
 *
 * The body is stored verbatim and forwarded verbatim, so parsing it would be both
 * pointless and lossy. Matching every content type (written `*[/]*` here, since the
 * literal would close this comment) is deliberate: senders set every content type
 * imaginable, and a webhook receiver that only accepts `application/json` drops
 * legitimate traffic.
 *
 * The limit is the change. This was mounted with no `limit` at all, so it silently used
 * body-parser's 100kb default — a bound nobody chose, nobody documented, and which
 * rejected larger payloads with an error the sender could not interpret (H-32). It is now
 * explicit and configurable.
 *
 * The `express.json()` that followed this line is gone: the wildcard type already consumed
 * every request, so body-parser's `_body` guard made the JSON parser unreachable.
 */
app.use(
  express.text({
    type: '*/*',
    limit: env.MAX_INGEST_BODY_BYTES,
  })
)

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'ingestion',
    // Reports readiness rather than just liveness: a process that is listening but has no
    // database connection cannot accept a single event.
    database: AppDataSource.isInitialized ? 'up' : 'down',
  })
})

app.use('/', ingestRouter)

/**
 * `Sentry.expressErrorHandler()` returns a middleware whose signature does not
 * structurally match Express 5's `ErrorRequestHandler`, so `app.use()` falls through to
 * its path overload and rejects the argument. `setupExpressErrorHandler` is the supported
 * entry point.
 */
Sentry.setupExpressErrorHandler(app)

/**
 * Oversized bodies get a 413 that says what happened.
 *
 * body-parser raises `entity.too.large`, which the default handler renders as an opaque
 * 500 — indistinguishable, to the sender, from the service being broken (H-32).
 */
app.use(
  (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error)
      return
    }

    const code =
      typeof error === 'object' && error !== null && 'type' in error
        ? (error as { type?: string }).type
        : undefined

    if (code === 'entity.too.large') {
      res.status(413).json({
        error: `Payload exceeds the ${env.MAX_INGEST_BODY_BYTES} byte limit`,
      })
      return
    }

    console.error(
      'Unhandled ingestion error:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
)

const start = async (): Promise<void> => {
  await initDB()
  httpServer.listen(env.PORT, () => {
    console.log(
      `Ingestion service listening on port ${env.PORT} (${env.NODE_ENV})`
    )
  })
}

/**
 * Graceful shutdown.
 *
 * Without it, a deploy or scale-down kills the process mid-request: an event that has been
 * written to Postgres but whose `deliveryQueue.add` has not yet been acknowledged is
 * simply never delivered, and nothing records that it was lost.
 */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}, shutting down ingestion service`)

  const timer = setTimeout(() => {
    console.error('Shutdown timed out after 10s, exiting')
    process.exit(1)
  }, 10_000)
  // Do not let the timer itself hold the event loop open.
  timer.unref()

  try {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await closeSocketServer()
    await closeQueues()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    clearTimeout(timer)
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
 * `start()` was called without a `.catch`, so a failed database connection produced an
 * unhandled rejection: in production the process stayed up, listening and answering
 * health checks, while every ingest attempt failed.
 */
start().catch((error: unknown) => {
  console.error(
    'Failed to start ingestion service:',
    error instanceof Error ? error.message : 'unknown error'
  )
  // A service that cannot reach its database should fail its health check outright rather
  // than stay up answering 500s.
  process.exit(1)
})
