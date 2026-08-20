import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import type { RedisReply } from 'rate-limit-redis'
import type { Request, Response } from 'express'
import { env } from '../config/env'
import { redis } from '../redis'
import { ingestContext } from './resolveEndpoint'

/**
 * Ingest rate limiting.
 *
 * State lives in Redis, so the limit holds across every replica rather than resetting per
 * process — that part was already right and is deliberately unchanged. Three things about it
 * were not (S-3):
 *
 *  - **Plan-blind.** `max: 60` was hardcoded for every account. A Team subscriber paying for
 *    500 000 events a month was capped at a free account's rate. The ceiling now comes from
 *    `plan.ingest_per_minute`, resolved per request by `resolveEndpoint`.
 *  - **Misleading.** Every 429 said `60 requests per minute allowed on free tier`, including
 *    to paying customers, so the message named a plan the caller was not on and a number that
 *    was not theirs.
 *  - **Shared demo bucket.** The key was `rate:<token>`, and the marketing demo is one token
 *    every visitor on the internet posts to. One person holding the demo button exhausted the
 *    bucket for everybody. Demo traffic is now keyed per client address.
 *
 * The key also no longer contains a capture token. `rate:<token>` put a live credential —
 * the ingest URL's only one — into a Redis key name, where it showed up in `KEYS`/`SCAN`
 * output, keyspace dumps and anything that samples them. Keys are now derived from the
 * account id, which is not a credential and, unlike the token, survives a token rotation
 * without handing the account a fresh bucket.
 */

/**
 * One bucket per account, not per endpoint.
 *
 * The allowance is a property of the plan, so the bucket has to be the thing the plan applies
 * to. Keying per endpoint would multiply the published rate by however many endpoints the
 * account has — and `endpoints: null` on pro and team means unlimited, so the effective limit
 * would have been unbounded for exactly the tiers with the most capacity to cause damage.
 *
 * The cost of that choice is real and accepted: one noisy endpoint can consume an account's
 * allowance and slow its siblings. A limit that means what the plan says is worth more than
 * insulating an account's endpoints from each other.
 */
const accountKey = (req: Request): string => `acct:${ingestContext(req).userId}`

/**
 * Demo traffic, isolated per client address.
 *
 * `ipKeyGenerator` normalises IPv6 to its /64, so a single allocation cannot be used to mint
 * unlimited keys. The bucket *size* is unchanged — it is still the demo account's plan rate —
 * because the defect was the shared boundary, not the number.
 *
 * This does mean total demo volume is no longer bounded per minute: a thousand visitors get a
 * thousand buckets. Two things still bound it, both outside this file — the demo account's
 * monthly event quota, which is enforced against Postgres in the handler, and the worker's
 * hourly demo cleanup, which stops the traffic from accumulating. Isolating a shared demo is
 * worth that trade; the alternative is a public feature any single visitor can switch off.
 */
const demoKey = (req: Request): string => `demo:${ipKeyGenerator(req.ip ?? '')}`

const isDemo = (req: Request): boolean =>
  req.params.token === env.DEMO_PUBLIC_TOKEN

/**
 * `express-rate-limit` attaches the resolved `{ limit, used, remaining, … }` to
 * `req.rateLimit` (its `requestPropertyName` default) but declares no global augmentation for
 * it — the exported `AugmentedRequest` types the property as an index signature over every
 * string key, which is too loose to be worth importing. This is the one field read here.
 */
type RateLimitedRequest = Request & {
  rateLimit?: { limit: number }
}

export const ingestRateLimiter = rateLimit({
  windowMs: 60 * 1000,

  /**
   * Resolved per request from the plan `resolveEndpoint` already loaded, so this costs no
   * extra query. `express-rate-limit` awaits a function here and validates the result.
   */
  limit: (req: Request) => ingestContext(req).plan.ingest_per_minute,

  standardHeaders: 'draft-7',
  legacyHeaders: false,

  keyGenerator: (req: Request) =>
    isDemo(req) ? demoKey(req) : accountKey(req),

  /**
   * Fail open if Redis cannot be reached.
   *
   * This is a change in behaviour and a deliberate one. Two facts decide it. First, this
   * limiter is a burst guard, not the security control on this path: the metered ceiling is
   * the monthly event quota, and `quota.service.ts` falls back to counting in Postgres when
   * Redis is down, so the account-level bound survives a cache outage regardless of what
   * happens here. Second, the BullMQ removal changed how a Redis outage presents. The shared
   * connection carried `maxRetriesPerRequest: null`, which BullMQ requires on blocking
   * connections and which makes every command wait indefinitely; it is now `3`, so commands
   * fail fast. Without this option that turns a Redis outage into a 500 on every inbound
   * webhook — from a service whose entire purpose is not losing them, with a perfectly
   * healthy database, while providers retry and eventually disable the endpoint.
   *
   * Rejecting captured webhooks because the *rate limiter's* cache is unavailable trades a
   * bounded, temporary loss of rate limiting for an unbounded, permanent loss of customer
   * data. The API service makes the opposite call on its credential endpoints, where the
   * limiter *is* the brute-force control and failing closed is the safe direction.
   */
  passOnStoreError: true,

  store: new RedisStore({
    prefix: 'rl:ingest:',
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as unknown as Promise<RedisReply>,
  }),

  /**
   * The 429 names the caller's own limit.
   *
   * `options.limit` is still the function at this point — `express-rate-limit` hands the
   * handler its raw config — so the resolved number is read from `req.rateLimit`, which the
   * middleware has already populated. The plan *id* is deliberately not in the response: the
   * ingest URL's only credential is the token in it, so anyone who has ever seen a capture URL
   * could otherwise read the account's subscription tier out of a 429. The same reasoning
   * already governs the monthly-quota rejection in `routes/ingest.ts`.
   */
  handler: (req: Request, res: Response, _next: unknown, options: Options) => {
    const allowed = (req as RateLimitedRequest).rateLimit?.limit ?? null
    const retryAfter = Math.ceil(options.windowMs / 1000)

    res.status(options.statusCode).json({
      error: 'Rate limit exceeded',
      message: allowed
        ? `This endpoint accepts ${allowed} requests per minute.`
        : 'Too many requests to this endpoint.',
      retry_after_seconds: retryAfter,
    })
  },
})
