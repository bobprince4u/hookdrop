import rateLimit, { Options, ipKeyGenerator } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import type { RedisReply } from 'rate-limit-redis'
import type { Request, Response } from 'express'
import { redis } from '../queue'
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
  handler: jsonHandler('Too many accounts created from this address.'),
})

export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
  store: store('refresh'),
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
  handler: jsonHandler('Too many requests.'),
})
