exports.shorthands = undefined

/**
 * Refresh-token store (H-16).
 *
 * The rotation logic in `services/token.service.ts` is complete — opaque random
 * tokens, HMAC-hashed at rest, single-use with reuse detection that revokes the whole
 * family — and none of it could ever have run, because the table it reads and writes
 * was declared only as a TypeORM entity and the DataSource runs with
 * `synchronize: false`. Every call to `/auth/refresh` would have failed on a missing
 * relation. This migration is what makes that code reachable.
 *
 * Only the HMAC of a token is stored. A read-only leak of this table therefore does
 * not let an attacker mint sessions: without `REFRESH_TOKEN_SECRET` the digests cannot
 * be inverted or recomputed.
 */
exports.up = (pgm) => {
  pgm.createTable('refresh_tokens', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: '"users"',
      onDelete: 'CASCADE',
      comment: 'sessions die with the account',
    },
    token_hash: {
      type: 'varchar(64)',
      notNull: true,
      comment:
        'HMAC-SHA256(token, REFRESH_TOKEN_SECRET) hex; never the raw token',
    },
    expires_at: {
      type: 'timestamptz',
      notNull: true,
    },
    revoked_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
      comment: 'set on logout, rotation, expiry sweep, or family revocation',
    },
    /**
     * Self-referencing, `ON DELETE SET NULL`.
     *
     * The FK is safe against both writers: rotation inserts the successor before
     * pointing the predecessor at it, and `purgeExpiredRefreshTokens` deletes rows
     * outright — which would otherwise strand a dangling reference from whichever
     * predecessor named the deleted row. SET NULL keeps the purge a plain DELETE.
     */
    replaced_by_id: {
      type: 'uuid',
      notNull: false,
      default: null,
      references: '"refresh_tokens"',
      onDelete: 'SET NULL',
      comment: 'successor token issued when this one was rotated',
    },
    user_agent: {
      type: 'varchar(255)',
      notNull: false,
      default: null,
    },
    created_ip: {
      type: 'varchar(45)',
      notNull: false,
      default: null,
      comment: '45 chars fits an IPv4-mapped IPv6 literal',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  /**
   * Unique, and that uniqueness is load-bearing rather than decorative: every lookup
   * in the rotation path finds a token by this column alone, so two rows sharing a
   * hash would make "which session is this" ambiguous at exactly the moment reuse
   * detection has to decide whether a token leaked.
   */
  pgm.createIndex('refresh_tokens', 'token_hash', {
    name: 'idx_refresh_tokens_token_hash',
    unique: true,
  })

  /** Supports logout-everywhere: `WHERE user_id = $1 AND revoked_at IS NULL`. */
  pgm.createIndex('refresh_tokens', 'user_id', {
    name: 'idx_refresh_tokens_user_id',
  })

  /**
   * Supports `purgeExpiredRefreshTokens`, which deletes by `expires_at < now()`.
   * Without it that sweep is a full scan over every session ever issued.
   */
  pgm.createIndex('refresh_tokens', 'expires_at', {
    name: 'idx_refresh_tokens_expires_at',
  })
}

exports.down = (pgm) => {
  pgm.dropTable('refresh_tokens')
}
