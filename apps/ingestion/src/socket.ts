import type { Server as HttpServer } from 'node:http'
import type IORedis from 'ioredis'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { allowedOrigins } from './config/env'
import { createRedisConnection } from './redis'

/**
 * Socket.IO server for the ingestion service (H-12).
 *
 * This is the fix for the bug the API's own comment claims was already fixed. Ingestion
 * ran `new Server(httpServer, { cors: { origin: '*' } })` with no adapter — and
 * `@socket.io/redis-adapter` was not even a dependency here — then emitted `new_event` on
 * that purely local server. The dashboard connects to the *API* process, so those emits
 * went to a server with no dashboard clients on it and live events never arrived.
 *
 * With the Redis adapter on both servers, a room emit from either process reaches clients
 * connected to the other.
 *
 * It also lives in its own module rather than in `index.ts`. `routes/ingest.ts` previously
 * did `import { io } from '../index'` while `index.ts` imported the router from
 * `routes/ingest.ts` — a cycle that happens to work only because the binding is read at
 * request time rather than at module load.
 */

let server: Server | null = null

/**
 * The adapter's connections, held so shutdown can close them.
 *
 * `server.close()` shuts the Socket.IO server down but knows nothing about the clients the
 * adapter was constructed with, so these were left open: two ioredis connections with active
 * handles, which keep the event loop alive and stop the process exiting on SIGTERM until the
 * platform's kill timeout fires.
 */
let adapterClients: readonly IORedis[] = []

export const createSocketServer = (httpServer: HttpServer): Server => {
  const origins = allowedOrigins()

  /**
   * The adapter needs its own pair of connections. The subscriber enters subscriber mode, in
   * which Redis rejects ordinary commands, so it cannot be the connection the rate limiter
   * and the quota cache use.
   */
  const pubClient = createRedisConnection('socket-pub')
  const subClient = createRedisConnection('socket-sub')
  adapterClients = [pubClient, subClient]

  server = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        // No Origin header means a non-browser client; allowed, without an echo.
        if (!origin || origins.has(origin)) {
          callback(null, true)
          return
        }
        callback(new Error('Origin not allowed'))
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
    // Engine.IO defaults to 1MB; this server only relays events, it never receives uploads.
    maxHttpBufferSize: 1e6,
  })

  /**
   * This service does not accept `join` from clients.
   *
   * Room membership is authorised by the API, which checks endpoint ownership against the
   * authenticated user before joining a socket to a token room (H-13). Ingestion only
   * *publishes* into those rooms, so exposing a join handler here would be a second,
   * unauthenticated way into a room the API guards.
   */
  return server
}

/**
 * Publishes an event into its endpoint's room.
 *
 * A narrow function rather than an exported `io`: the caller does not need the server
 * object, and if the socket server is not up yet this is a no-op instead of a crash on
 * `undefined.to`. Delivery does not depend on it — the event and its delivery job are
 * already committed by the time this runs.
 */
export const emitNewEvent = (room: string, payload: unknown): void => {
  if (!server) return

  try {
    server.to(room).emit('new_event', payload)
  } catch (error) {
    console.error(
      'Failed to publish new_event:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

export const closeSocketServer = async (): Promise<void> => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve())
    })
    server = null
  }

  // After the server, so a final relayed emit is not cut off mid-publish.
  await Promise.allSettled(adapterClients.map((client) => client.quit()))
  adapterClients = []
}
