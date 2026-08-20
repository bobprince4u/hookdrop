import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import type { RedisReply } from 'rate-limit-redis'
import type { Request, Response } from 'express'
import { redis } from '../redis'
import type { AuthRequest } from './auth'

/**
 * Rate limiting for the API.
 *
 * `express-rate-limit` was already a dependency here but was never mounted — only
 * the ingestion service limited anything, leaving login, registration, token
 * refresh, AI generation and the public demo routes completely unthrottled (H-19).
 *
 * State lives in Redis so limits hold across replicas rather than resetting per
 * process. Correct client IPs depend on `trust proxy` being configured, which the
 * app now does explicitly (H-07).
 *
 * ## What happens when Redis is unreachable
 *
 * The limiters below split on this, deliberately, because they are not all doing the same
 * job. The BullMQ removal is what forced the question: the shared connection carried
 * `maxRetriesPerRequest: null` — required by BullMQ on blocking connections, and the reason
 * a Redis outage used to make commands hang rather than fail. It is now `3`, so store errors
 * surface immediately, and `express-rate-limit`'s default is to reject the request.
 *
 * Where the limiter *is* the security control, that default is correct and stays: without it,
 * a Redis outage becomes unlimited password guessing (`login`), unlimited account enumeration
 * (`register`), unlimited refresh-token probing (`refresh`), unmetered spend against a paid
 * model (`ai`), or an unthrottled write amplifier into the delivery queue (`replay`). Failing
 * those closed costs availability on five routes for the duration of the outage.
 *
 * Where the limiter is a fairness guard, failing closed is the worse outcome: `apiRateLimiter`
 * is mounted on the entire authenticated surface, so rejecting on a store error turns a cache
 * blip into a total product outage while the database is healthy. Those pass the request
 * through instead, which is a documented, bounded loss of throttling rather than an outage.
 */

const store = (prefix: string): RedisStore =>
  new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as unknown as Promise<RedisReply>,
  })

/**
 * Prefer the authenticated user id: limiting purely by IP lets one NAT'd office
 * exhaust a shared bucket, and lets one attacker rotate IPs freely.
 * `ipKeyGenerator` normalises IPv6 so a /64 cannot be used to mint unlimited keys.
 */
const userOrIpKey = (req: Request): string => {
  const userId = (req as AuthRequest).user?.id
  return userId ? `u:${userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`
}

const jsonHandler =
  (message: string) =>
  (_req: Request, res: Response, _next: unknown, options: Options): void => {
    res.status(options.statusCode).json({
      error: 'Rate limit exceeded',
      message,
      retry_after_seconds: Math.ceil(options.windowMs / 1000),
    })
  }

/** Credential endpoints: strict, per IP, because there is no user id yet. */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  store: store('login'),
  // The brute-force control on this route. Fails closed on a store error; see the header.
  passOnStoreError: false,
  handler: jsonHandler('Too many sign-in attempts. Try again shortly.'),
})

/**
 * Registration is the account-enumeration surface: a duplicate-email response is
 * how you learn an address exists. Throttling is what makes bulk enumeration
 * impractical while keeping the honest "email already registered" message (H-25).
 */
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  store: store('register'),
  // The brute-force control on this route. Fails closed on a store error; see the header.
  passOnStoreError: false,
  handler: jsonHandler('Too many accounts created from this address.'),
})

export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  store: store('refresh'),
  // The brute-force control on this route. Fails closed on a store error; see the header.
  passOnStoreError: false,
  handler: jsonHandler('Too many token refresh attempts.'),
})

/** AI routes call a paid model, so they are metered separately and per user. */
export const aiRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: store('ai'),
  // A spend control. Fails closed on a store error rather than leaving a paid model
  // unmetered; see the header.
  passOnStoreError: false,
  handler: jsonHandler('AI request limit reached for this hour.'),
})

/** Unauthenticated public routes, including the demo (H-24). */
export const publicRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  store: store('public'),
  // A fairness guard, not a security control. Passes the request through on a store error
  // rather than turning a cache blip into an outage; see the header.
  passOnStoreError: true,
  handler: jsonHandler('Too many requests to the public demo.'),
})

/** Replay writes to the delivery queue, so it gets a tighter bucket than reads. */
export const replayRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: store('replay'),
  // A write amplifier: each request resets delivery rows and enqueues a job. Fails closed on
  // a store error; see the header.
  passOnStoreError: false,
  handler: jsonHandler('Too many replay requests.'),
})

/** Catch-all applied to the whole authenticated surface. */
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: store('api'),
  // A fairness guard, not a security control. Passes the request through on a store error
  // rather than turning a cache blip into an outage; see the header.
  passOnStoreError: true,
  handler: jsonHandler('Too many requests.'),
})
