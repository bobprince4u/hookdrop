import crypto from 'node:crypto'
import { IsNull } from 'typeorm'
import { AppDataSource } from '../db'
import { ApiKey } from '../entities/ApiKey'
import { env } from '../config/env'

/**
 * Issuing and verifying programmatic API keys (H-27).
 *
 * ## Why this exists
 *
 * The settings page already offered "Copy API token", handing out the raw access JWT from
 * `localStorage` for use as a long-lived credential. Three things were wrong with that: the
 * token cannot be revoked without rotating `JWT_SECRET` for every user, it carries the same
 * authority as the browser session including account-security operations, and H-16 reduces
 * its lifetime to 15 minutes — which silently breaks every integration built on the
 * advertised feature. A separate credential type is the only way to keep the capability.
 *
 * ## Shape of a key
 *
 *     hdk_<43 url-safe base64 characters>        // 32 random bytes
 *
 * The `hdk_` label is what lets `authenticate` tell a key from a JWT without parsing either,
 * and what makes a leaked key recognisable in a log or a repository scan.
 *
 * ## Storage
 *
 * Only `HMAC-SHA256(key, pepper)` is stored, hex, matching `token.service.ts`. Verification
 * is a single indexed lookup on that hash rather than a scan with a constant-time compare per
 * row: the compared value is already a hash of a 256-bit random secret, so there is no
 * low-entropy input for a timing oracle to recover, and an unindexed scan over every key in
 * the table would be its own denial-of-service surface. This is the same construction GitHub
 * and Stripe use for their key formats.
 */

const KEY_LABEL = 'hdk'
const KEY_BYTES = 32
/** `hdk_` plus eight characters — enough to identify a key in a list, useless as a credential. */
const PREFIX_LENGTH = KEY_LABEL.length + 1 + 8

/**
 * A per-user ceiling exists so a compromised session cannot mint keys without limit, leaving
 * a mess that has to be cleaned up one revocation at a time.
 */
export const MAX_ACTIVE_KEYS_PER_USER = 10

/** Bounded so a mistyped expiry cannot create a key that outlives the business. */
export const MAX_KEY_LIFETIME_DAYS = 730

/**
 * Pepper for the stored hashes.
 *
 * `API_KEY_SECRET` when configured; otherwise derived from `REFRESH_TOKEN_SECRET` through an
 * HMAC with a domain-separation label, so the two purposes never share a key even though they
 * may share a root secret. Deriving rather than reusing is what guarantees an API-key hash and
 * a refresh-token hash of the same input are different values, so neither table's rows can be
 * replayed against the other.
 *
 * Computed once at import: this is a hot path, and the value cannot change while the process
 * lives.
 */
const KEY_PEPPER: string =
  env.API_KEY_SECRET ??
  crypto
    .createHmac('sha256', env.REFRESH_TOKEN_SECRET)
    .update('hookdrop:api-key-pepper:v1')
    .digest('hex')

const hashKey = (raw: string): string =>
  crypto.createHmac('sha256', KEY_PEPPER).update(raw).digest('hex')

/** Cheap shape test, so a JWT is never sent through a database lookup. */
export const looksLikeApiKey = (token: string): boolean =>
  token.startsWith(`${KEY_LABEL}_`)

export interface IssuedApiKey {
  /** The only time the plaintext key exists on the server. Never stored, never logged. */
  readonly key: string
  readonly record: ApiKeyView
}

/** The fields safe to return to a client. Excludes `key_hash` entirely. */
export interface ApiKeyView {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly last_used_at: Date | null
  readonly expires_at: Date | null
  readonly created_at: Date
}

const toView = (key: ApiKey): ApiKeyView => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  last_used_at: key.last_used_at,
  expires_at: key.expires_at,
  created_at: key.created_at,
})

/**
 * Failures the caller caused, carrying the status the controller should return.
 *
 * One class with a status, rather than a family the controller has to enumerate: every new
 * client-error case then arrives with its own status instead of falling through to a 500.
 */
export class ApiKeyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message)
    this.name = 'ApiKeyRequestError'
  }
}

export class ApiKeyLimitError extends ApiKeyRequestError {
  constructor(readonly limit: number) {
    // 409, not 403: the request is permitted, the account's current state is what blocks it.
    super(`An account may have at most ${limit} active API keys`, 409)
    this.name = 'ApiKeyLimitError'
  }
}

export const countActiveKeys = async (userId: string): Promise<number> =>
  AppDataSource.getRepository(ApiKey).count({
    where: { user_id: userId, revoked_at: IsNull() },
  })

export const listApiKeys = async (userId: string): Promise<ApiKeyView[]> => {
  const keys = await AppDataSource.getRepository(ApiKey).find({
    where: { user_id: userId, revoked_at: IsNull() },
    order: { created_at: 'DESC' },
  })
  return keys.map(toView)
}

export const createApiKey = async (
  userId: string,
  name: string,
  expiresInDays?: number
): Promise<IssuedApiKey> => {
  /**
   * Re-checked here rather than trusted from the route: `createApiKeySchema` applies the same
   * bound, but a service that only holds when its caller validated first is one refactor away
   * from holding not at all.
   */
  if (expiresInDays !== undefined) {
    if (
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_KEY_LIFETIME_DAYS
    ) {
      throw new ApiKeyRequestError(
        `expires_in_days must be a whole number between 1 and ${MAX_KEY_LIFETIME_DAYS}`
      )
    }
  }

  const active = await countActiveKeys(userId)
  if (active >= MAX_ACTIVE_KEYS_PER_USER) {
    throw new ApiKeyLimitError(MAX_ACTIVE_KEYS_PER_USER)
  }

  const key = `${KEY_LABEL}_${crypto.randomBytes(KEY_BYTES).toString('base64url')}`

  const repo = AppDataSource.getRepository(ApiKey)
  const record = repo.create({
    user_id: userId,
    name,
    prefix: key.slice(0, PREFIX_LENGTH),
    key_hash: hashKey(key),
    expires_at:
      expiresInDays === undefined
        ? null
        : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
    last_used_at: null,
    revoked_at: null,
  })

  const saved = await repo.save(record)

  return { key, record: toView(saved) }
}

/**
 * Revokes one key belonging to `userId`.
 *
 * Scoped by `user_id` in the same statement as the id, so a caller cannot revoke another
 * tenant's key by guessing a uuid — the H-03 pattern, applied here from the start rather than
 * as a fix. Returns false when nothing matched, which covers both "not yours" and "already
 * revoked" without telling the caller which.
 */
export const revokeApiKey = async (
  userId: string,
  keyId: string
): Promise<boolean> => {
  const result = await AppDataSource.getRepository(ApiKey).update(
    { id: keyId, user_id: userId, revoked_at: IsNull() },
    { revoked_at: new Date() }
  )
  return (result.affected ?? 0) > 0
}

/** How stale `last_used_at` is allowed to get, in minutes. */
const LAST_USED_THROTTLE_MINUTES = 5

/**
 * Records use without adding a write to every authenticated request.
 *
 * The `WHERE` clause makes all but one request per interval a no-op that touches no row, and
 * the call is not awaited by the caller: a failed bookkeeping update must never fail an
 * otherwise valid request.
 *
 * The interval is bound as a parameter rather than interpolated, so this file contains no
 * string-built SQL for a reviewer to have to reason about.
 */
const touchLastUsed = (keyId: string): void => {
  void AppDataSource.query(
    `UPDATE api_keys
        SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL
             OR last_used_at < now() - ($2 || ' minutes')::interval)`,
    [keyId, String(LAST_USED_THROTTLE_MINUTES)]
  ).catch((error: unknown) => {
    console.warn(
      'Failed to record API key usage:',
      error instanceof Error ? error.message : 'unknown error'
    )
  })
}

export interface ApiKeyIdentity {
  readonly keyId: string
  readonly user: { id: string; email: string; plan: string }
}

/**
 * Resolves a presented key to the account it belongs to, or null.
 *
 * Returns null for every failure — unknown, revoked, expired, deleted account — so the caller
 * cannot turn the distinction into an enumeration oracle.
 *
 * The user is loaded through an explicit nested `select`, so `password_hash` is not read into
 * memory on a path that runs for every API request (H-48).
 */
export const authenticateApiKey = async (
  raw: string
): Promise<ApiKeyIdentity | null> => {
  const key = await AppDataSource.getRepository(ApiKey).findOne({
    where: { key_hash: hashKey(raw), revoked_at: IsNull() },
    relations: { user: true },
    select: {
      id: true,
      expires_at: true,
      user: { id: true, email: true, plan: true },
    },
  })

  if (!key || !key.user) return null

  if (key.expires_at && key.expires_at.getTime() <= Date.now()) return null

  touchLastUsed(key.id)

  return {
    keyId: key.id,
    user: { id: key.user.id, email: key.user.email, plan: key.user.plan },
  }
}
