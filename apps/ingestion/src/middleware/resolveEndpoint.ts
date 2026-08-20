import type { NextFunction, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import {
  resolveEffectivePlan,
  type PlanDefinition,
} from '../services/plan.service'

/**
 * Resolves the capture token to an endpoint, its owner, and the plan that owner is actually
 * entitled to — once per request, before anything else looks at it.
 *
 * This exists so the rate limiter can be plan-aware without paying for it. The limit is a
 * property of the account's plan, and the plan is only knowable from the database, so
 * something has to load it before the limiter decides how many requests are allowed. Doing
 * that lookup *here* rather than inside the limiter keeps the count at one query per request:
 * the handler used to run this same query itself, and now reads the result off the request.
 *
 * Two alternatives were considered and rejected:
 *
 *  - **A second query inside the limiter.** Doubles the database work on the hottest path in
 *    the system to learn something the handler is about to load anyway.
 *  - **A Redis token → plan cache.** Adds a third piece of state that can be stale, and a
 *    stale entry either throttles a customer who has just upgraded or keeps granting a rate
 *    to one who has lapsed. Entitlement is exactly the kind of thing that should not be
 *    cached on the enforcement path.
 *
 * ## Ordering note
 *
 * Running before the limiter means an unknown token costs a database query and is answered
 * 404 without touching Redis. That is not a regression: the limiter could never tell a valid
 * token from an invalid one either, so an unknown-token flood already reached this query. It
 * does remove one amplification — the old key `rate:<token>` was created per distinct token,
 * so a flood of random tokens minted unbounded Redis keys, and now it mints none. What
 * neither ordering provides is protection against that flood itself; see `docs/hardening.md`.
 */

/** Only what the ingest path needs. `password_hash` never enters process memory. */
export interface ResolvedEndpoint {
  readonly id: string
  readonly userId: string
  readonly user: {
    readonly id: string
    readonly email: string
    readonly name: string
  }
  readonly plan: PlanDefinition
}

export interface IngestRequest extends Request {
  ingest?: ResolvedEndpoint
}

/**
 * Narrow by design.
 *
 * `relations: ['user']` selected every user column, `password_hash` included, on every
 * inbound webhook. Nothing on this path needs it, and a bcrypt digest that never enters
 * process memory cannot be leaked by a log line or a crash dump.
 */
const findActiveEndpoint = async (token: string) =>
  AppDataSource.getRepository(Endpoint).findOne({
    where: { public_token: token, is_active: true },
    relations: { user: true },
    select: {
      id: true,
      user_id: true,
      user: {
        id: true,
        email: true,
        name: true,
        plan: true,
        plan_expires_at: true,
      },
    },
  })

export const resolveEndpoint = async (
  req: IngestRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const token = req.params.token as string

  try {
    const endpoint = await findActiveEndpoint(token)

    if (!endpoint || !endpoint.user) {
      // Same answer for a bad token, a disabled endpoint, and a deleted owner.
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    req.ingest = {
      id: endpoint.id,
      userId: endpoint.user_id,
      user: {
        id: endpoint.user.id,
        email: endpoint.user.email,
        name: endpoint.user.name,
      },
      /**
       * The effective plan, not the stored column (H-29). An expired paid plan resolves to
       * free here, so both the rate limit and the monthly quota are the ones the account is
       * entitled to at this instant rather than the ones it used to have.
       */
      plan: resolveEffectivePlan(endpoint.user),
    }

    next()
  } catch (error) {
    // Message only: the error object carries the failing query and its parameters (H-48).
    console.error(
      'Endpoint resolution failed:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * The resolved endpoint, for code that runs after this middleware.
 *
 * Throws rather than returning undefined: reaching the limiter or the handler without it
 * means the middleware was not mounted, which is a wiring mistake to surface loudly in
 * development, not a condition to handle at runtime.
 */
export const ingestContext = (req: Request): ResolvedEndpoint => {
  const resolved = (req as IngestRequest).ingest
  if (!resolved) {
    throw new Error(
      'resolveEndpoint must be mounted before anything that reads req.ingest'
    )
  }
  return resolved
}
