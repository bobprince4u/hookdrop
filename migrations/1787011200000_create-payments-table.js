exports.shorthands = undefined

/**
 * Payments ledger (H-06, H-37).
 *
 * This table is the arbiter of payment idempotency. `billing.controller.ts` inserts
 * with `.orIgnore()` and treats "no row returned" as "already processed", which only
 * works if `payments_provider_reference_unique` actually exists in the database.
 *
 * It was declared solely as a TypeORM `@Unique` decorator on the entity, and the
 * DataSource runs with `synchronize: false`, so neither the table nor the constraint
 * was ever created. Every replayed webhook therefore inserted a fresh row, reported
 * `isNew = true`, and added another 30 days of subscription. This migration is what
 * makes the existing replay-detection code effective.
 *
 * Append-only by convention: rows are inserted, never updated or deleted, so the
 * ledger stays a faithful record of what each provider told us and what we did.
 */
exports.up = (pgm) => {
  pgm.createTable('payments', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    /**
     * Nullable and ON DELETE SET NULL: a deleted user must not erase the financial
     * record. Webhooks whose metadata names no valid user also land here as NULL.
     */
    user_id: {
      type: 'uuid',
      notNull: false,
      default: null,
      references: '"users"',
      onDelete: 'SET NULL',
      comment: 'user the payment was applied to; null when unattributable',
    },
    provider: {
      type: 'varchar(50)',
      notNull: true,
      comment: 'paystack, flutterwave, stripe',
    },
    provider_reference: {
      type: 'varchar(255)',
      notNull: true,
      comment:
        "provider transaction id, or a namespaced synthetic key (intent:, unverified:, ignored:, noref:, cancel:)",
    },
    event_type: {
      type: 'varchar(100)',
      notNull: true,
    },
    amount_minor: {
      type: 'bigint',
      notNull: false,
      default: null,
      comment: 'amount in the minor unit (kobo, cents) as charged or expected',
    },
    currency: {
      type: 'varchar(3)',
      notNull: false,
      default: null,
    },
    plan: {
      type: 'varchar(50)',
      notNull: false,
      default: null,
      comment: 'plan granted, or expected for an intent row',
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
    },
    reason: {
      type: 'text',
      notNull: false,
      default: null,
      comment: 'why a webhook was rejected or ignored; never contains secrets',
    },
    payload_digest: {
      type: 'varchar(64)',
      notNull: false,
      default: null,
      comment: 'SHA-256 of the exact bytes verified, for dispute resolution',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  /**
   * The idempotency arbiter. Without this the `.orIgnore()` in `recordPayment` is a
   * plain INSERT that always succeeds, and replay protection does not exist.
   */
  pgm.addConstraint(
    'payments',
    'payments_provider_reference_unique',
    'UNIQUE (provider, provider_reference)'
  )

  /**
   * Status and plan are constrained, but deliberately permissively where the value
   * originates outside our control.
   *
   * `status` is only ever written by our own code, so it is enumerated strictly.
   *
   * `plan` is written from webhook metadata on the rejection path, where the whole
   * point is to record that the provider asked for something invalid. A strict CHECK
   * there would make the audit INSERT throw and lose the very record of the rejected
   * webhook, so the controller normalises an unrecognised plan to NULL and preserves
   * the requested string in `reason`. The CHECK then guards against our own bugs
   * rather than against attacker input.
   */
  pgm.addConstraint(
    'payments',
    'payments_status_check',
    "CHECK (status IN ('initiated', 'succeeded', 'rejected', 'ignored'))"
  )
  pgm.addConstraint(
    'payments',
    'payments_plan_check',
    "CHECK (plan IS NULL OR plan IN ('free', 'starter', 'pro', 'team'))"
  )

  /**
   * Deliberately NO check on `amount_minor`.
   *
   * The value is provider-reported and the ledger's job is to record faithfully. A
   * `>= 0` constraint would abort the INSERT on an anomalous amount and destroy the
   * audit record of that anomaly — the same trap as a strict `plan` check, and the
   * opposite of what an append-only ledger is for.
   */

  // Named to match the entity decorators so TypeORM and the database agree.
  pgm.createIndex('payments', 'user_id', { name: 'idx_payments_user_id' })
  pgm.createIndex('payments', 'created_at', { name: 'idx_payments_created_at' })

  /**
   * Supports the intent lookup the webhook performs before granting a plan:
   * `WHERE provider = $1 AND provider_reference = $2 AND status = 'initiated'`.
   *
   * Partial on status because intent rows are never updated — the ledger is
   * append-only, so a consumed intent keeps `status = 'initiated'` and replay
   * protection comes from the unique constraint on the outcome row instead.
   */
  pgm.createIndex('payments', ['provider', 'provider_reference'], {
    name: 'idx_payments_intent_lookup',
    where: "status = 'initiated'",
  })
}

exports.down = (pgm) => {
  pgm.dropTable('payments')
}
