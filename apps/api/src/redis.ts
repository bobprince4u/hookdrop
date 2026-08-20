import IORedis, { RedisOptions } from 'ioredis'
import { env, redisTlsOptions } from './config/env'

/**
 * Redis connections for the API.
 *
 * This was the top half of `queue/index.ts`, which owned both the Redis connection and the
 * BullMQ queue registry. The queues moved to Postgres (see `queue/index.ts`), and Redis
 * stayed — so the two are separated here rather than left entangled. A module named
 * `../queue` that also exported the connection behind the Socket.IO adapter and every rate
 * limiter is how "remove the queue" turns into "log everyone out and break the live feed".
 *
 * ## Why Redis is still here
 *
 * The migration removed the only *queue* use of Redis. Two non-queue uses remain, and both
 * need state shared across replicas:
 *
 *  - **Socket.IO adapter** (`index.ts`) — the dashboard's socket lands on one replica while
 *    the event that should reach it is ingested by another process entirely. Without the
 *    adapter, room emits never cross the process boundary (H-12).
 *  - **Rate limiting** (`middleware/rateLimiter.ts`) — login, registration, refresh, AI and
 *    the public demo are all throttled here, and a per-process counter multiplies every one
 *    of those limits by the replica count. For the credential endpoints that is a security
 *    control, not a nicety.
 *
 * Neither is a queue and neither is being reimplemented on Postgres as part of this
 * migration. Redis is retained deliberately, with a smaller job than it had.
 *
 * ## What the original module got wrong (still worth recording)
 *
 * Two modules both claimed the name `../queue`: this directory module, which read
 * `REDIS_URL`, and a sibling `queue.ts` holding `new IORedis()` with no arguments. Node
 * resolves `../queue` to the file before the directory, so the argument-less one was the live
 * code path for outbound email — silently pointing at localhost in every environment (H-09).
 * The URL is required configuration, and `rediss://` gets TLS here and not only in the worker
 * (H-38).
 */

/**
 * `maxRetriesPerRequest` is now bounded, and that is a deliberate behaviour change.
 *
 * It was `null` — retry a command for ever — because BullMQ *requires* that on the
 * connections it blocks on, and this connection was shared with BullMQ. Nothing here blocks
 * any more, so `null` has stopped being a requirement and started being a liability: during a
 * Redis outage every rate-limiter check would hang indefinitely instead of failing, holding
 * the request and its socket open until the client gave up. A bounded count turns that into
 * an error within seconds — a failure an operator can see and a request can finish on.
 *
 * `enableOfflineQueue` stays at its default of `true`, so a reconnect measured in
 * milliseconds queues rather than errors. The bound applies once the connection is genuinely
 * gone.
 */
const connectionOptions = (): RedisOptions => ({
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  ...redisTlsOptions(),
})

/**
 * A named connection.
 *
 * Socket.IO's adapter needs its own pair: the subscriber enters subscriber mode, in which
 * Redis rejects ordinary commands, so it cannot be the connection the rate limiters use. The
 * `role` only labels errors — without it, three connections report failures
 * indistinguishably.
 */
export const createRedisConnection = (role: string): IORedis => {
  const connection = new IORedis(env.REDIS_URL, connectionOptions())

  connection.on('error', (error: Error) => {
    /**
     * The message only. An ioredis connection error can carry the options it was constructed
     * with, and `REDIS_URL` contains the instance password (H-48).
     */
    console.error(`API Redis (${role}) error:`, error.message)
  })

  return connection
}

/** Shared command connection: every rate limiter store. */
export const redis = createRedisConnection('cache')

/**
 * Closes the command connection on shutdown.
 *
 * The Socket.IO adapter's pair is created and closed in `index.ts`, next to the server that
 * owns it. `quit` rather than `disconnect` so an in-flight limiter increment completes.
 */
export const closeRedis = async (): Promise<void> => {
  await redis.quit().catch((error: unknown) => {
    console.error(
      'Error closing Redis connection:',
      error instanceof Error ? error.message : 'unknown error'
    )
  })
}
