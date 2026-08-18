import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { IsNull } from 'typeorm'
import { AppDataSource } from '../db'
import { RefreshToken } from '../entities/RefreshToken'
import { env } from '../config/env'

const ISSUER = 'hookdrop'
const AUDIENCE = 'hookdrop-api'
const REFRESH_TOKEN_BYTES = 32

export interface AccessTokenPayload {
  id: string
  email: string
  plan: string
  typ: 'access'
}

export interface UserIdentity {
  id: string
  email: string
  plan: string
}

/**
 * `typ` is what stops a refresh token from being replayed as an access token, and
 * issuer/audience pin the token to this service. Tokens minted before these claims
 * existed no longer verify — which is intentional: while `JWT_SECRET` had a public
 * fallback value, every previously issued token had to be considered forgeable (H-01).
 */
export const signAccessToken = (user: UserIdentity): string =>
  jwt.sign(
    { id: user.id, email: user.email, plan: user.plan, typ: 'access' },
    env.JWT_SECRET,
    {
      expiresIn: env.ACCESS_TOKEN_TTL,
      issuer: ISSUER,
      audience: AUDIENCE,
    } as jwt.SignOptions
  )

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    issuer: ISSUER,
    audience: AUDIENCE,
  })

  if (typeof decoded !== 'object' || decoded === null) {
    throw new jwt.JsonWebTokenError('Malformed token payload')
  }

  const claims = decoded as Partial<AccessTokenPayload>
  if (claims.typ !== 'access') {
    throw new jwt.JsonWebTokenError('Token is not an access token')
  }
  if (!claims.id || !claims.email || !claims.plan) {
    throw new jwt.JsonWebTokenError('Access token is missing required claims')
  }

  return {
    id: claims.id,
    email: claims.email,
    plan: claims.plan,
    typ: 'access',
  }
}

/**
 * Peppered hash: an attacker with read access to `refresh_tokens` still cannot
 * derive a usable token without `REFRESH_TOKEN_SECRET`.
 */
const hashRefreshToken = (raw: string): string =>
  crypto.createHmac('sha256', env.REFRESH_TOKEN_SECRET).update(raw).digest('hex')

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
}

/** Parses the `30d` / `15m` / `3600s` forms shared with jsonwebtoken. */
export const parseDurationMs = (value: string): number => {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim())
  if (!match) {
    throw new Error(`Unsupported duration: ${value}`)
  }
  return Number(match[1]) * DURATION_UNITS[match[2]]
}

export interface RefreshContext {
  userAgent?: string
  ip?: string
}

export interface IssuedRefreshToken {
  token: string
  expiresAt: Date
}

export const issueRefreshToken = async (
  userId: string,
  context: RefreshContext = {}
): Promise<IssuedRefreshToken> => {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + parseDurationMs(env.REFRESH_TOKEN_TTL))

  const repo = AppDataSource.getRepository(RefreshToken)
  await repo.save(
    repo.create({
      user_id: userId,
      token_hash: hashRefreshToken(raw),
      expires_at: expiresAt,
      revoked_at: null,
      replaced_by_id: null,
      user_agent: context.userAgent?.slice(0, 255) ?? null,
      created_ip: context.ip?.slice(0, 45) ?? null,
    })
  )

  return { token: raw, expiresAt }
}

export type RotationResult =
  | { outcome: 'rotated'; userId: string; refresh: IssuedRefreshToken }
  | { outcome: 'invalid' }
  | { outcome: 'race'; userId: string }
  | { outcome: 'reused'; userId: string }

/**
 * How recently a token must have been replaced for a second presentation of it to be
 * read as a race rather than as a leak.
 *
 * Rotation and multi-tab browsing collide by construction. Two tabs restoring the same
 * session send the same cookie in the same instant; `FOR UPDATE` serialises them, so the
 * loser necessarily finds a row that was revoked microseconds earlier. Treating that as
 * a stolen token signs the user out of every device for opening a second tab — a
 * self-inflicted denial of service that fires far more often than the attack it is
 * looking for.
 *
 * The loser is answered with a plain 401 and nothing is revoked. Its cookie has already
 * been replaced by the winner's `Set-Cookie`, so retrying the refresh succeeds, which is
 * exactly what the frontend does on `code: 'refresh_race'`.
 *
 * A token presented again *after* this window is a different claim: the legitimate client
 * moved on to the successor long ago, so someone else is holding a copy. That still
 * revokes the family. Ten seconds covers a slow page load, not a session, and an attacker
 * who wins this race gains one 401 and no token.
 */
const ROTATION_RACE_WINDOW_MS = 10_000

/**
 * Consumes a refresh token and issues its replacement inside one transaction.
 *
 * The row is locked with `FOR UPDATE`, so two concurrent refreshes cannot both consume
 * the same token. Presenting a token that was replaced longer ago than
 * `ROTATION_RACE_WINDOW_MS` means the token leaked, so the whole family is revoked and
 * the caller must re-authenticate.
 */
export const rotateRefreshToken = async (
  raw: string,
  context: RefreshContext = {}
): Promise<RotationResult> => {
  const tokenHash = hashRefreshToken(raw)

  return AppDataSource.transaction(async (manager) => {
    const existing = await manager
      .getRepository(RefreshToken)
      .createQueryBuilder('rt')
      .setLock('pessimistic_write')
      .where('rt.token_hash = :tokenHash', { tokenHash })
      .getOne()

    if (!existing) {
      return { outcome: 'invalid' as const }
    }

    if (existing.revoked_at !== null) {
      /**
       * Revoked with no successor means logout or logout-all revoked it deliberately. A
       * client that retries afterwards is stale, not hostile, and there is nothing left
       * to revoke.
       */
      if (existing.replaced_by_id === null) {
        return { outcome: 'invalid' as const }
      }

      if (
        Date.now() - existing.revoked_at.getTime() <=
        ROTATION_RACE_WINDOW_MS
      ) {
        return { outcome: 'race' as const, userId: existing.user_id }
      }

      await manager
        .getRepository(RefreshToken)
        .update(
          { user_id: existing.user_id, revoked_at: IsNull() },
          { revoked_at: new Date() }
        )
      return { outcome: 'reused' as const, userId: existing.user_id }
    }

    if (existing.expires_at.getTime() <= Date.now()) {
      await manager
        .getRepository(RefreshToken)
        .update({ id: existing.id }, { revoked_at: new Date() })
      return { outcome: 'invalid' as const }
    }

    const nextRaw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
    const nextExpiresAt = new Date(
      Date.now() + parseDurationMs(env.REFRESH_TOKEN_TTL)
    )
    const repo = manager.getRepository(RefreshToken)
    const next = await repo.save(
      repo.create({
        user_id: existing.user_id,
        token_hash: hashRefreshToken(nextRaw),
        expires_at: nextExpiresAt,
        revoked_at: null,
        replaced_by_id: null,
        user_agent: context.userAgent?.slice(0, 255) ?? null,
        created_ip: context.ip?.slice(0, 45) ?? null,
      })
    )

    await repo.update(
      { id: existing.id },
      { revoked_at: new Date(), replaced_by_id: next.id }
    )

    return {
      outcome: 'rotated' as const,
      userId: existing.user_id,
      refresh: { token: nextRaw, expiresAt: nextExpiresAt },
    }
  })
}

export const revokeRefreshToken = async (raw: string): Promise<void> => {
  await AppDataSource.getRepository(RefreshToken).update(
    { token_hash: hashRefreshToken(raw), revoked_at: IsNull() },
    { revoked_at: new Date() }
  )
}

export const revokeAllRefreshTokensForUser = async (
  userId: string
): Promise<void> => {
  await AppDataSource.getRepository(RefreshToken).update(
    { user_id: userId, revoked_at: IsNull() },
    { revoked_at: new Date() }
  )
}

/** Best-effort cleanup of tokens that can no longer be used. */
export const purgeExpiredRefreshTokens = async (
  before: Date = new Date()
): Promise<number> => {
  const result = await AppDataSource.getRepository(RefreshToken)
    .createQueryBuilder()
    .delete()
    .where('expires_at < :before', { before })
    .execute()
  return result.affected ?? 0
}
