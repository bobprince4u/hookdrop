import { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { isProduction } from '../config/env'
import {
  issueRefreshToken,
  revokeAllRefreshTokensForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../services/token.service'
import { sendWelcomeEmail, sendWelcomeSequence } from '../services/email.service'
import { resolveEffectivePlan } from '../services/plan.service'

const BCRYPT_COST = 12

/**
 * A real bcrypt hash of a random value, compared against when no account matches.
 *
 * Without it, a request for a non-existent email skips the ~100ms hash comparison
 * entirely, and the response-time difference is a reliable account oracle (H-25).
 */
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-for-timing-parity', BCRYPT_COST)

const REFRESH_COOKIE = 'hookdrop_rt'
const REFRESH_COOKIE_PATH = '/api/auth'

/**
 * Refresh tokens are delivered as an httpOnly cookie so that browser JavaScript —
 * and therefore any XSS payload — cannot read them (H-16). The token is also
 * returned in the response body for non-browser clients, which is why rotation
 * and reuse detection in `token.service.ts` matter: a leaked token is single-use
 * and its reuse revokes the entire family.
 */
const setRefreshCookie = (
  res: Response,
  token: string,
  expiresAt: Date
): void => {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    // The dashboard and the API are served from different registrable domains, so
    // the cookie has to be cross-site in production.
    sameSite: isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  })
}

const clearRefreshCookie = (res: Response): void => {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
  })
}

const readRefreshToken = (req: Request): string | undefined => {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[
    REFRESH_COOKIE
  ]
  if (fromCookie) return fromCookie
  const fromBody = (req.body as { refreshToken?: unknown } | undefined)
    ?.refreshToken
  return typeof fromBody === 'string' && fromBody.length > 0
    ? fromBody
    : undefined
}

const publicUser = (user: User) => {
  const effective = resolveEffectivePlan(user)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // Report the plan the user is actually entitled to, so an expired
    // subscription is not presented to the dashboard as still active (H-29).
    plan: effective.id,
    stored_plan: user.plan,
    plan_expires_at: user.plan_expires_at ?? null,
  }
}

const requestContext = (req: Request) => ({
  userAgent: req.headers['user-agent'],
  ip: req.ip,
})

/** Body is already validated and normalised by `validateBody(registerSchema)`. */
export const register = async (req: Request, res: Response): Promise<void> => {
  const { email, name, password } = req.body as {
    email: string
    name: string
    password: string
  }

  try {
    const userRepo = AppDataSource.getRepository(User)

    const existing = await userRepo.findOne({ where: { email } })
    if (existing) {
      res.status(409).json({ error: 'Email already registered' })
      return
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_COST)

    let savedUser: User
    try {
      savedUser = await userRepo.save(
        userRepo.create({ email, name, password_hash, plan: 'free' })
      )
    } catch (error) {
      // Two concurrent registrations for the same address: the unique index on
      // users.email is the real arbiter, not the check above.
      if (isUniqueViolation(error)) {
        res.status(409).json({ error: 'Email already registered' })
        return
      }
      throw error
    }

    const accessToken = signAccessToken(savedUser)
    const refresh = await issueRefreshToken(savedUser.id, requestContext(req))
    setRefreshCookie(res, refresh.token, refresh.expiresAt)

    // Fire and forget: a mail failure must not fail registration, but it is
    // logged by the email service rather than silently discarded.
    void sendWelcomeEmail(savedUser.email, savedUser.name)
    void sendWelcomeSequence(savedUser.email, savedUser.name)

    res.status(201).json({
      user: publicUser(savedUser),
      accessToken,
      refreshToken: refresh.token,
      expiresAt: refresh.expiresAt.toISOString(),
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email: string; password: string }

  try {
    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ where: { email } })

    // Always run one comparison so the timing of "no such account" and "wrong
    // password" is indistinguishable.
    const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)

    if (!user || !valid) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const accessToken = signAccessToken(user)
    const refresh = await issueRefreshToken(user.id, requestContext(req))
    setRefreshCookie(res, refresh.token, refresh.expiresAt)

    res.json({
      user: publicUser(user),
      accessToken,
      refreshToken: refresh.token,
      expiresAt: refresh.expiresAt.toISOString(),
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Exchanges a refresh token for a new access token and a replacement refresh token.
 *
 * Rotation is single-use. Presenting a token that was already rotated means the
 * token leaked, so every session for that user is revoked and the client is forced
 * to sign in again (H-16).
 */
export const refresh = async (req: Request, res: Response): Promise<void> => {
  const token = readRefreshToken(req)

  if (!token) {
    res.status(401).json({ error: 'Refresh token required' })
    return
  }

  try {
    const result = await rotateRefreshToken(token, requestContext(req))

    if (result.outcome === 'invalid') {
      clearRefreshCookie(res)
      res.status(401).json({ error: 'Invalid refresh token' })
      return
    }

    /**
     * Another tab rotated this token microseconds ago.
     *
     * The cookie this browser now holds is the winner's replacement, so the answer is
     * "try again" — and the cookie must **not** be cleared, because clearing it would
     * destroy the valid token the winner was just issued and log the user out anyway.
     * Nothing is revoked and nothing is logged as suspicious.
     */
    if (result.outcome === 'race') {
      res.status(401).json({
        error: 'A refresh for this session is already in progress; retry',
        code: 'refresh_race',
      })
      return
    }

    if (result.outcome === 'reused') {
      clearRefreshCookie(res)
      console.warn(
        `Refresh token reuse detected for user ${result.userId}; all sessions revoked`
      )
      res.status(401).json({
        error: 'Refresh token already used; all sessions have been revoked',
        code: 'refresh_token_reuse',
      })
      return
    }

    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: result.userId },
    })

    if (!user) {
      clearRefreshCookie(res)
      res.status(401).json({ error: 'Account no longer exists' })
      return
    }

    setRefreshCookie(res, result.refresh.token, result.refresh.expiresAt)

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: result.refresh.token,
      expiresAt: result.refresh.expiresAt.toISOString(),
      user: publicUser(user),
    })
  } catch (error) {
    console.error('Refresh error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/** Revokes the presented session. Idempotent, and safe to call without a token. */
export const logout = async (req: Request, res: Response): Promise<void> => {
  const token = readRefreshToken(req)

  try {
    if (token) {
      await revokeRefreshToken(token)
    }
  } catch (error) {
    console.error('Logout error:', error)
  } finally {
    clearRefreshCookie(res)
    res.status(204).end()
  }
}

/** Revokes every session for the authenticated user. */
export const logoutAll = async (
  req: Request & { user?: { id: string } },
  res: Response
): Promise<void> => {
  try {
    await revokeAllRefreshTokensForUser(req.user!.id)
    clearRefreshCookie(res)
    res.status(204).end()
  } catch (error) {
    console.error('Logout-all error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === '23505'
