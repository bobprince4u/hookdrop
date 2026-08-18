exports.shorthands = undefined

/**
 * Index for resolving a cancellation webhook back to a user (H-30).
 *
 * `handleDowngrade` previously identified the user from webhook metadata alone, which
 * Stripe's `customer.subscription.deleted` does not carry — so cancellations were
 * rejected and a cancelled subscription silently stayed paid. Resolving instead by
 * `payment_subscription_id` (falling back to `payment_customer_id`, then metadata)
 * needs an index on that column; `1775074884440` indexed `payment_provider` and
 * `payment_customer_id` but not this one.
 *
 * Partial: the column is NULL for every free user, and NULL rows are never the target
 * of this lookup.
 */
exports.up = (pgm) => {
  pgm.createIndex('users', 'payment_subscription_id', {
    name: 'idx_users_payment_subscription_id',
    where: 'payment_subscription_id IS NOT NULL',
  })
}

exports.down = (pgm) => {
  pgm.dropIndex('users', 'payment_subscription_id', {
    name: 'idx_users_payment_subscription_id',
  })
}
