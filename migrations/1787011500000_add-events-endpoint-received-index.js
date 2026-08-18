exports.shorthands = undefined

/**
 * Composite index on `events (endpoint_id, received_at)` (H-37), and the redundant
 * single-column index it replaces.
 *
 * `Event` carries `@Index('idx_events_endpoint_received', ['endpoint_id', 'received_at'])`
 * in all three services and nothing ever created it — the same entity-decorator-without-a-
 * migration pattern as `payments` and `users.plan_expires_at`. With `synchronize: false` the
 * decorator is documentation, not DDL.
 *
 * Two callers need it:
 *
 *  - the dashboard's only event query, "this endpoint's events, newest first", which today
 *    filters on `events_endpoint_id_index` and then sorts the whole matched set;
 *  - the per-plan retention job (H-18), which deletes by `(endpoint_id, received_at <
 *    cutoff)` one endpoint at a time. Without this index that delete is a sequential scan of
 *    the largest table in the schema, once per plan tier, every hour.
 *
 * `1774644478912` created `events_endpoint_id_index` on `endpoint_id` alone. A composite
 * whose leading column is `endpoint_id` serves every lookup that index served — including
 * the `ON DELETE CASCADE` from `endpoints` — so keeping both means paying for two index
 * writes on every inbound webhook, which is the hottest insert path in the system. The
 * single-column index is dropped here and recreated by `down`, so the migration is
 * reversible in both directions.
 *
 * Order matters: the composite is created before the other is dropped, so no window exists
 * in which `endpoint_id` has no index behind it.
 */
exports.up = (pgm) => {
  pgm.createIndex('events', ['endpoint_id', 'received_at'], {
    name: 'idx_events_endpoint_received',
    ifNotExists: true,
  })

  pgm.dropIndex('events', 'endpoint_id', { ifExists: true })
}

exports.down = (pgm) => {
  pgm.createIndex('events', 'endpoint_id', { ifNotExists: true })

  pgm.dropIndex('events', ['endpoint_id', 'received_at'], {
    name: 'idx_events_endpoint_received',
    ifExists: true,
  })
}
