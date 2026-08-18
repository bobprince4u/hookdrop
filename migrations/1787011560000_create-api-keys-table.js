exports.shorthands = undefined

/**
 * `api_keys` (H-27).
 *
 * The finding was not only "there is no API-key table". `settings/page.tsx` ships a **"Copy
 * API token" button that hands the user their raw access JWT** out of `localStorage`,
 * captioned "Use this to authenticate direct API requests" — so the product already
 * advertises programmatic access, implemented by handing out a session credential. H-16
 * shortens that token to 15 minutes and moves it out of `localStorage`, which breaks the
 * advertised feature outright. This table is what replaces it, which is why the two ship
 * together rather than in sequence.
 *
 * Column notes:
 *
 *  - `key_hash` stores an HMAC-SHA256 of the presented key, hex, peppered with a server-side
 *    secret — the same construction `refresh_tokens` uses. The plaintext key exists exactly
 *    once, in the response that creates it. A database dump yields no usable credential.
 *  - `UNIQUE (key_hash)` is what makes verification a single indexed lookup instead of a scan
 *    with a per-row compare, and it is a real constraint in the database rather than an entity
 *    decorator — the H-06/H-37 mistake was trusting a decorator with `synchronize: false`.
 *  - `prefix` is the first few characters of the key, stored so the dashboard can show which
 *    key is which. It is not a secret and cannot be used to authenticate.
 *  - `revoked_at` and `expires_at` are timestamps rather than a boolean, because "when" is
 *    the question asked during an incident. Both are checked at verification time; neither is
 *    a soft delete the lookup can forget, since the partial index below only covers rows the
 *    lookup will accept.
 *  - `last_used_at` supports the one question a user asks before deleting a key they no
 *    longer recognise: is anything still using it.
 */
exports.up = (pgm) => {
  pgm.createTable('api_keys', {
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
    },
    name: {
      type: 'varchar(100)',
      notNull: true,
    },
    prefix: {
      type: 'varchar(24)',
      notNull: true,
    },
    key_hash: {
      type: 'varchar(64)',
      notNull: true,
    },
    last_used_at: {
      type: 'timestamptz',
    },
    expires_at: {
      type: 'timestamptz',
    },
    revoked_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.addConstraint('api_keys', 'api_keys_key_hash_unique', 'UNIQUE (key_hash)')

  /**
   * Partial: the only listing query is "this user's keys that are still live", and the
   * active-key cap counts the same set. Revoked rows are kept for audit but never scanned.
   */
  pgm.createIndex('api_keys', 'user_id', {
    name: 'idx_api_keys_user_active',
    where: 'revoked_at IS NULL',
  })
}

exports.down = (pgm) => {
  pgm.dropTable('api_keys')
}
