exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.addColumns('users', {
    payment_provider: {
      type: 'varchar(50)',
      notNull: false,
      default: null,
      comment: 'e.g. paystack, stripe, paddle',
    },
    payment_customer_id: {
      type: 'varchar(255)',
      notNull: false,
      default: null,
      comment: 'per-provider customer/subscription ID',
    },
    payment_subscription_id: {
      type: 'varchar(255)',
      notNull: false,
      default: null,
      comment: 'subscription ID from the provider',
    },
    plan_expires_at: {
      type: 'timestamptz',
      notNull: false,
      default: null,
      comment: 'when the current paid plan expires',
    },
  })

  pgm.createIndex('users', 'payment_provider')
  pgm.createIndex('users', 'payment_customer_id')
}

exports.down = (pgm) => {
  pgm.dropColumns('users', [
    'payment_provider',
    'payment_customer_id',
    'payment_subscription_id',
    'plan_expires_at',
  ])
}
