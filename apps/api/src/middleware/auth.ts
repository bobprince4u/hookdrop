import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { adminEmails } from '../config/env'
import { verifyAccessToken } from '../services/token.service'
import {
  authenticateApiKey,
  looksLikeApiKey,
} from '../services/apiKey.service'
import {
  PlanDefinition,
  PlanId,
  PLAN_IDS,
  resolveEffectivePlan,
} from '../services/plan.service'

/** Which credential the caller presented. Consumed by `denyApiKeyAuth`. */
export type AuthMethod = 'access_token' | 'api_key'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    plan: string
  }
  /** Populated by `loadCurrentUser`. Authoritative, unlike the token claims. */
  currentUser?: User
  /** Populated by `loadCurrentUser`. Accounts for `plan_expires_at`. */
  effectivePlan?: PlanDefinition
  /** Set by `authenticate`. Absent means the request was never authenticated. */
  authMethod?: AuthMethod
  /** Set only for API-key requests, so a revocation can be traced to what used it. */
  apiKeyId?: string
}

/**
 * Verifies the bearer credential, which may be either an access token or an API key.
 *
 * The signing key comes from validated configuration, so there is no longer a
 * hardcoded fallback that would let anyone mint a token for any account (H-01).
 * `verifyAccessToken` also rejects refresh tokens and tokens issued for a
 * different audience.
 *
 * API keys are accepted here rather than through a parallel middleware (H-27). Two reasons:
 * a route that forgot to mount the second middleware would silently accept only one credential
 * type, and every authorization check downstream — `loadCurrentUser`, `requirePlan`,
 * `requireAdmin`, and every controller's `req.user!.id` — then works unchanged for both. The
 * shapes are distinguishable without parsing either (`hdk_` prefix), so there is no ambiguity
 * to resolve and no attempt to validate a key as a JWT.
 *
 * What an API key deliberately does *not* get is access to account-security routes; see
 * `denyApiKeyAuth`.
 */
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  if (looksLikeApiKey(token)) {
    try {
      const identity = await authenticateApiKey(token)
      if (!identity) {
        // One message for unknown, revoked and expired alike, so the response cannot be
        // used to learn which keys exist.
        res.status(401).json({ error: 'Invalid API key', code: 'invalid_api_key' })
        return
      }
      req.user = identity.user
      req.authMethod = 'api_key'
      req.apiKeyId = identity.keyId
      next()
    } catch (error) {
      /**
       * A database failure must not be reported as an authentication failure: telling a
       * client its valid key is invalid sends it to rotate a credential that was fine.
       */
      console.error(
        'API key verification failed:',
        error instanceof Error ? error.message : 'unknown error'
      )
      res.status(503).json({ error: 'Authentication temporarily unavailable' })
    }
    return
  }

  try {
    const claims = verifyAccessToken(token)
    req.user = { id: claims.id, email: claims.email, plan: claims.plan }
    req.authMethod = 'access_token'
    next()
  } catch (error) {
    // Distinguish expiry so the client knows to refresh rather than to re-login.
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired', code: 'token_expired' })
      return
    }
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

/**
 * Refuses API keys on routes where possession of a long-lived integration credential must not
 * be enough (H-27).
 *
 * The set of such routes is not arbitrary: it is everything that could be used to keep or widen
 * access — changing the password or email, issuing or revoking keys, and moving money. An
 * integration key lives in a CI secret store, a Lambda env var, a Postman collection; it is
 * copied and shared in ways a session cookie is not. Treating it as equivalent to a freshly
 * authenticated browser session for those operations would mean one leaked key is a full
 * account takeover rather than a revocable loss of API access.
 *
 * Mounted after `authenticate`, since it reads what `authenticate` recorded.
 */
export const denyApiKeyAuth = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  if (req.authMethod === 'api_key') {
    res.status(403).json({
      error: 'This operation requires an interactive session, not an API key',
      code: 'api_key_forbidden',
    })
    return
  }

  next()
}

/**
 * Loads the authoritative user row and resolves the plan they are actually
 * entitled to. Access-token claims are up to one token lifetime stale, which is
 * fine for identity but not for entitlement decisions.
 */
export const loadCurrentUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: req.user!.id },
    })

    if (!user) {
      // The token is validly signed but the account is gone.
      res.status(401).json({ error: 'Account no longer exists' })
      return
    }

    req.currentUser = user
    req.effectivePlan = resolveEffectivePlan(user)
    next()
  } catch (error) {
    console.error('Failed to load current user:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  team: 3,
}

/**
 * Gate a route on an active paid plan. Fails closed: if the plan cannot be
 * resolved the request is denied rather than allowed through (H-26 fixed the
 * inverse, where the plan-limit middleware's catch block called `next()`).
 */
export const requirePlan = (minimum: PlanId) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const effective = req.effectivePlan
    if (!effective) {
      res.status(500).json({
        error: 'Plan context missing; loadCurrentUser must run first',
      })
      return
    }

    if (PLAN_RANK[effective.id] < PLAN_RANK[minimum]) {
      res.status(403).json({
        error: `This feature requires the ${minimum} plan or higher`,
        code: 'plan_required',
        current_plan: effective.id,
        required_plan: minimum,
        // Surfacing expiry lets the dashboard tell "never subscribed" apart from
        // "subscription lapsed" without an extra round trip.
        plan_expired:
          req.currentUser != null &&
          PLAN_IDS.includes(req.currentUser.plan as PlanId) &&
          req.currentUser.plan !== 'free' &&
          effective.id === 'free',
      })
      return
    }

    next()
  }
}

/**
 * Admin gate.
 *
 * Reads a comma-separated allow-list from `ADMIN_EMAILS` (falling back to the
 * single `ADMIN_EMAIL` used previously) and fails closed when the list is empty,
 * instead of relying on `undefined !== undefined` coincidentally denying (H-07).
 */
export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const allowed = adminEmails()

  if (allowed.size === 0) {
    console.error(
      'Admin route denied: ADMIN_EMAILS is not configured on this instance'
    )
    res.status(403).json({ error: 'Not authorized' })
    return
  }

  const email = req.user?.email?.toLowerCase()
  if (!email || !allowed.has(email)) {
    res.status(403).json({ error: 'Not authorized' })
    return
  }

  next()
}
