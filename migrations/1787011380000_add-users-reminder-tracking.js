exports.shorthands = undefined

/**
 * Reminder idempotency latch (H-10).
 *
 * `User.last_reminder_sent_at` exists on the entity and had no column behind it, so
 * the subscription scheduler had nowhere to record that it had already emailed a user.
 * Combined with a scheduler that runs on a fixed interval, that means every run
 * re-sends the same expiry reminder to the same people for as long as they sit inside
 * the reminder window.
 *
 * A latch column rather than a "sent reminders" table: the scheduler needs to answer
 * one question — "have I already told this user?" — and a nullable timestamp on the row
 * it is already reading answers it without a join.
 *
 * `ifNotExists` because the entity has declared this property for some time, and a
 * developer database may have been created with `synchronize` briefly enabled. Adding
 * the column twice should be a no-op, not a failed migration.
 */
exports.up = (pgm) => {
  pgm.addColumns(
    'users',
    {
      last_reminder_sent_at: {
        type: 'timestamptz',
        notNull: false,
        default: null,
        comment:
          'last time a plan-expiry reminder was emailed; NULL means never sent',
      },
    },
    { ifNotExists: true }
  )
}

exports.down = (pgm) => {
  pgm.dropColumns('users', ['last_reminder_sent_at'], { ifExists: true })
}
