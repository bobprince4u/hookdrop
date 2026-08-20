import IORedis, { RedisOptions } from 'ioredis'
import { env, redisTlsOptions } from './config/env'

/**
 * Redis connections for the ingestion service.
 *
 * This module used to be half of `queue/index.ts`, which owned both the Redis connections
 * and the BullMQ queue registry. The queue moved to Postgres (see `queue/index.ts` for why),
 * and Redis stayed — so the two are separated here rather than left entangled, because a
 * module named `../queue` that also happened to export the Socket.IO adapter's connections
 * is exactly how "remove the queue" turns into "break the dashboard".
 *
 * ## Why Redis is still here
 *
 * The migration to pg-boss removed the only *queue* use of Redis. Three non-queue uses
 * remain, each of which genuinely needs a shared store across replicas:
 *
 *  - **Socket.IO adapter** (`socket.ts`) — a dashboard socket is connected to one replica
 *    while the event that should reach it is ingested by another. Without the adapter the
 *    live feed silently shows nothing on any multi-replica deployment (H-12).
 *  - **Rate limiting** (`middleware/rateLimiter.ts`) — a per-process counter multiplies the
 *    real limit by the replica count.
 *  - **Monthly quota counter** (`services/quota.service.ts`) — a `COUNT(*)` over `events`
 *    on every inbound request is the single most expensive thing this service could do; the
 *    cache is what makes the quota check affordable.
 *
 * None of those is a queue, none of them was created to work around the queue, and none of
 * them is being reimplemented on top of Postgres as part of this migration. Redis is
 * therefore retained deliberately, with a smaller job than it had.
 *
 * ## What the original module got wrong (kept here because it is still relevant)
 *
 * 1. `process.env.REDIS_URL || 'redis://localhost:6379'` — combined with a
 *    `dotenv.config({ path: '../../.env' })` that only resolved when the process was started
 *    from `apps/ingestion` (H-44), a hosted deployment silently connected to a local Redis
 *    that does not exist. Events were accepted, written to Postgres, and never queued. The
 *    URL is required configuration (H-09).
 * 2. No TLS for `rediss://`, so a managed Redis refused the connection outright (H-38).
 */

/**
 * `maxRetriesPerRequest` is now bounded, and that is a deliberate behaviour change.
 *
 * It was `null` — retry a command for ever — because BullMQ *requires* that on the
 * connections it blocks on, and this connection was shared with BullMQ. Nothing here blocks
 * any more, so `null` has stopped being a requirement and started being a liability: during
 * a Redis outage every rate-limiter check and every quota read would hang indefinitely
 * instead of failing, holding the request, its socket and its database connection open until
 * the client gave up. A bounded count turns that into an error in a few seconds, which is a
 * failure an operator can see and a request can finish on.
 *
 * `enableOfflineQueue` is left at its default of `true` so a reconnect measured in
 * milliseconds — a failover, a deploy of the Redis instance — queues rather than errors.
 * The bound only applies once the connection is genuinely gone.
 */
const connectionOptions = (): RedisOptions => ({
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  ...redisTlsOptions(),
})

/**
 * A named connection.
 *
 * Socket.IO's Redis adapter needs its own pair: the subscriber goes into subscriber mode,
 * where Redis rejects ordinary commands, so it cannot be the connection the rate limiter and
 * the quota cache are using. The `role` is only used to label errors — without it, three
 * connections report failures indistinguishably.
 */
export const createRedisConnection = (role: string): IORedis => {
  const connection = new IORedis(env.REDIS_URL, connectionOptions())

  connection.on('error', (error: Error) => {
    /**
     * The message only. An ioredis connection error can carry the connection options it was
     * constructed with, and `REDIS_URL` contains the instance password (H-48).
     */
    console.error(`Ingestion Redis (${role}) error:`, error.message)
  })

  return connection
}

/** Shared command connection: rate limiter and quota cache. */
export const redis = createRedisConnection('cache')

/**
 * Closes the command connection on shutdown.
 *
 * The Socket.IO adapter's pair is closed by `socket.ts`, which is what owns them. `quit`
 * rather than `disconnect` so in-flight commands — a quota increment for a request that was
 * accepted moments ago — are allowed to complete.
 */
export const closeRedis = async (): Promise<void> => {
  await redis.quit().catch((error: unknown) => {
    console.error(
      'Error closing Redis connection:',
      error instanceof Error ? error.message : 'unknown error'
    )
  })
}
