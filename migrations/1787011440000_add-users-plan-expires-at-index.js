exports.shorthands = undefined

/**
 * Index behind `User.plan_expires_at` (H-37).
 *
 * The entity carries `@Index('idx_users_plan_expires_at')` and nothing created it —
 * `1775074884440` added the column but indexed only `payment_provider` and
 * `payment_customer_id`. Two hot paths scan this column:
 *
 *  - the subscription scheduler, which sweeps for plans expiring inside a date range
 *    on every run;
 *  - `resolveEffectivePlan`, indirectly, wherever expiry is filtered in SQL rather
 *    than in application code.
 *
 * Partial on NOT NULL. Free users are the overwhelming majority of rows and all of them
 * have NULL here, so excluding them keeps the index small — and no query targets NULL,
 * because "expires at NULL on a paid plan" is decided in application code (deliberately
 * treated as expired, so a cancellation cannot read as a perpetual upgrade), never by a
 * range scan.
 */
exports.up = (pgm) => {
  pgm.createIndex('users', 'plan_expires_at', {
    name: 'idx_users_plan_expires_at',
    where: 'plan_expires_at IS NOT NULL',
    ifNotExists: true,
  })
}

exports.down = (pgm) => {
  pgm.dropIndex('users', 'plan_expires_at', {
    name: 'idx_users_plan_expires_at',
    ifExists: true,
  })
}
