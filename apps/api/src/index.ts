import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { env, isProduction } from './config/env'
import { initDB } from './db'
import router from './routes'
import { createRedisConnection, closeRedis } from './redis'
import { startQueue, closeQueue } from './queue'
import { verifyAccessToken } from './services/token.service'
import { apiRateLimiter } from './middleware/rateLimiter'
import { AppDataSource } from './db'
import { Endpoint } from './entities/Endpoint'
import { handleWebhook } from './controllers/billing.controller'

/**
 * The adapter's own pair of connections.
 *
 * This was `createAdapter(redis, redis.duplicate())`, which reused the shared command
 * connection as the publisher and created an anonymous duplicate as the subscriber. The
 * duplicate had no error listener and no reference anywhere, so it could neither be diagnosed
 * nor closed: two ioredis handles stayed open through shutdown and kept the event loop alive
 * until the platform's kill timeout. A named pair is closable and reports its own errors.
 */
const socketPub = createRedisConnection('socket-pub')
const socketSub = createRedisConnection('socket-sub')

/**
 * Config is validated at import time by `./config/env`, which exits the process if
 * a required variable is missing. Nothing below needs to defend against undefined.
 */
Sentry.init({
  dsn: env.SENTRY_DSN,
  environment: env.NODE_ENV,
  // 1.0 in production traced every request (H-43).
  tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
})

const app = express()
const httpServer = createServer(app)

/**
 * Origin allow-list.
 *
 * The two hardcoded production hostnames are kept so an existing deployment does
 * not break, but they are no longer the only source: `FRONTEND_URL` is required in
 * production and `EXTRA_ORIGINS` remains available for previews.
 */
const allowedOrigins = new Set(
  [
    'http://localhost:3004',
    'https://hookdropi.vercel.app',
    'https://hookdropi.qzz.io',
    env.FRONTEND_URL,
    ...(env.EXTRA_ORIGINS?.split(',') ?? []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
)

/**
 * `trust proxy` must reflect the real number of proxies in front of the app.
 *
 * Without it, `req.ip` is the proxy's address, so every rate limiter buckets the
 * entire internet into one key. With a blanket `true` it is whatever the client
 * puts in `X-Forwarded-For`, so every limiter is trivially bypassed. A hop count
 * is the only setting that is correct in both directions (H-07).
 */
app.set('trust proxy', env.TRUST_PROXY_HOPS)

/**
 * Shared adapter so a room emit from one process reaches clients connected to
 * another.
 *
 * The ingestion service runs its own Socket.IO server and emitted `new_event` on
 * it, while the dashboard connects to this one — so live events never arrived. Both
 * servers now publish through Redis (H-12).
 */
export const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }
      callback(new Error('Origin not allowed'))
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  adapter: createAdapter(socketPub, socketSub),
  // Engine.IO's default is 1MB; events are relayed, not uploaded.
  maxHttpBufferSize: 1e6,
})

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
)

/**
 * Single CORS implementation.
 *
 * The hand-rolled middleware it replaces echoed `Access-Control-Allow-Origin: *`
 * together with `Allow-Credentials: true` whenever the request had no `Origin`
 * header, and answered every preflight with 200 regardless of origin (H-41).
 */
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header: same-origin, curl, or a server-to-server call. Allowed,
      // but without an `Access-Control-Allow-Origin` echo.
      if (!origin) {
        callback(null, false)
        return
      }
      callback(null, allowedOrigins.has(origin))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
)

/**
 * The payment webhook is mounted before the JSON parser and receives the raw
 * bytes, because signature verification runs over exactly what the provider sent.
 * Re-serialising a parsed object changes key order and whitespace and can never
 * reproduce the signature (H-05).
 */
app.post(
  '/api/billing/webhook',
  express.raw({ type: '*/*', limit: '512kb' }),
  handleWebhook
)

// Bounded bodies everywhere else. The default 100kb was already implicit; making
// it explicit documents the limit and keeps urlencoded from being unbounded (H-32).
app.use(express.json({ limit: '256kb' }))
app.use(express.urlencoded({ extended: true, limit: '256kb' }))
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api' })
})

// Coarse ceiling for the whole API; per-route limiters are tighter.
app.use('/api', apiRateLimiter, router)

/**
 * Body-parser failures, translated into the status codes they actually are (H-32).
 *
 * Explicit body limits are only half a fix. Without this, exceeding one produced a
 * `PayloadTooLargeError` that fell through to the generic handler below and was
 * reported as `500 Internal server error` — telling the client the server broke when
 * the server had in fact worked correctly and rejected an oversized request. A caller
 * cannot act on a 500; a 413 that names the limit tells them exactly what to change.
 *
 * Malformed JSON is handled in the same place for the same reason: it was also a 500,
 * and it is just as plainly a 400.
 *
 * Registered *before* Sentry's handler so neither of these reaches the error tracker.
 * Both are client-side conditions, and an easily-triggered public route that files an
 * issue on every oversized body is a denial-of-service against your own alerting.
 */
interface BodyParserError extends Error {
  type?: string
  status?: number
  limit?: number
  length?: number
}

app.use(
  (
    error: BodyParserError,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (res.headersSent) {
      next(error)
      return
    }

    if (error?.type === 'entity.too.large') {
      res.status(413).json({
        error: 'Request body too large',
        code: 'payload_too_large',
        // Names only what the client needs to correct the request.
        limit_bytes: error.limit ?? null,
      })
      return
    }

    if (error?.type === 'entity.parse.failed') {
      res.status(400).json({
        error: 'Request body is not valid JSON',
        code: 'invalid_json',
      })
      return
    }

    if (error?.type === 'encoding.unsupported') {
      res.status(415).json({
        error: 'Unsupported content encoding',
        code: 'unsupported_encoding',
      })
      return
    }

    // Client hung up mid-upload. Nothing to report and nobody to answer.
    if (error?.type === 'request.aborted') {
      return
    }

    next(error)
  }
)

/**
 * Sentry's error handler, registered after the routes and before our own fallback.
 *
 * `Sentry.expressErrorHandler()` returns a middleware whose signature does not
 * structurally match Express 5's `ErrorRequestHandler`, so `app.use()` falls through
 * to its path overload and rejects the argument. `setupExpressErrorHandler` is the
 * supported entry point and installs the same handler.
 */
Sentry.setupExpressErrorHandler(app)

/**
 * Fallback error handler.
 *
 * Express 5 forwards rejected promises here. Without it, a thrown error produced a
 * default HTML response carrying the stack trace.
 */
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled API error:', error)
    if (res.headersSent) return
    res.status(500).json({ error: 'Internal server error' })
  }
)

/**
 * Socket.IO authentication.
 *
 * `join` used to accept any string and put the caller in that room. Endpoint
 * public tokens are the ingest URL's only credential, so knowing or guessing one
 * gave a live feed of another tenant's webhook traffic — including headers and
 * bodies — with no authentication at all (H-13).
 *
 * Sockets may connect anonymously (the marketing demo does), but an anonymous
 * socket can only ever join the demo room.
 */
io.use((socket, next) => {
  const raw = socket.handshake.auth?.token
  const token = typeof raw === 'string' ? raw : undefined

  if (!token) {
    socket.data.userId = null
    next()
    return
  }

  try {
    const payload = verifyAccessToken(token)
    socket.data.userId = payload.id
    next()
  } catch {
    /**
     * `verifyAccessToken` *throws* on a malformed, expired, or wrong-audience token —
     * it never returns null, so the previous `if (!payload)` guard was unreachable and
     * the throw escaped this middleware. Socket.IO does not wrap middleware calls, so
     * one bad handshake token was an uncaught exception and took the process down.
     *
     * Rejecting is also the only safe branch: falling through to the anonymous path
     * would hand demo-room access to a caller who presented a token we just refused.
     */
    next(new Error('unauthorized'))
  }
})

io.on('connection', (socket) => {
  socket.on('join', async (token: unknown) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 100) {
      socket.emit('join_error', { error: 'Invalid room' })
      return
    }

    // The public demo feed stays public — that is intentional product behaviour.
    if (token === env.DEMO_PUBLIC_TOKEN) {
      await socket.join(token)
      socket.emit('joined', { ok: true })
      return
    }

    const userId = socket.data.userId as string | null
    if (!userId) {
      socket.emit('join_error', { error: 'Authentication required' })
      return
    }

    try {
      const endpoint = await AppDataSource.getRepository(Endpoint).findOne({
        where: { public_token: token, user_id: userId },
        select: { id: true },
      })

      if (!endpoint) {
        // Same answer for "not yours" and "does not exist".
        socket.emit('join_error', { error: 'Endpoint not found' })
        return
      }

      await socket.join(token)
      socket.emit('joined', { ok: true })
    } catch (error) {
      console.error('Socket join error:', error)
      socket.emit('join_error', { error: 'Could not join' })
    }
  })
})

/**
 * Graceful shutdown.
 *
 * The order matters: stop accepting connections first, then release the things a request
 * still finishing might need, and the database last. A replay in flight during the drain is
 * inside a transaction that writes delivery rows *and* its queue job, so closing the database
 * under it would roll back work the caller is about to be told succeeded.
 *
 * The Socket.IO adapter's connections are closed explicitly. `io.close()` shuts the server
 * down but knows nothing about the Redis clients the adapter was built with, and they were
 * previously left open — which is why the process needed the platform's kill timeout to exit.
 */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}, shutting down`)
  io.close()
  httpServer.close()
  await Promise.allSettled([socketPub.quit(), socketSub.quit()])
  await closeQueue().catch((error: unknown) =>
    console.error(
      'Error closing queue:',
      error instanceof Error ? error.message : 'unknown error'
    )
  )
  await closeRedis()
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy().catch((error) =>
      console.error('Error closing database:', error)
    )
  }
  process.exit(0)
}

/**
 * Nothing starts listening until the database and the queue are both ready.
 *
 * `startQueue` verifies that the pg-boss schema is installed and that the `delivery` and
 * `email` queues exist, and throws if not — so a replica that cannot queue a replay or an
 * onboarding email refuses to boot rather than failing those requests one at a time.
 */
const start = async (): Promise<void> => {
  await initDB()
  await startQueue()
  httpServer.listen(env.PORT, () => {
    console.log(
      `API service running on port ${env.PORT} (${env.NODE_ENV}, ${allowedOrigins.size} allowed origins)`
    )
  })
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

start().catch((error) => {
  console.error('Failed to start API service:', error)
  process.exit(1)
})

// `isProduction` is re-exported for modules that need it without importing config.
export { isProduction }
