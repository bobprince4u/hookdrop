exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('deliveries', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    event_id: {
      type: 'uuid',
      notNull: true,
      references: '"events"',
      onDelete: 'CASCADE',
    },
    destination_id: {
      type: 'uuid',
      notNull: true,
      references: '"destinations"',
      onDelete: 'CASCADE',
    },
    attempt_count: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'pending',
    },
    response_code: {
      type: 'integer',
    },
    response_body: {
      type: 'text',
    },
    last_attempted_at: {
      type: 'timestamptz',
    },
    delivered_at: {
      type: 'timestamptz',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('deliveries', 'event_id')
  pgm.createIndex('deliveries', 'destination_id')
  pgm.createIndex('deliveries', 'status')
  pgm.addConstraint(
    'deliveries',
    'deliveries_event_destination_unique',
    'UNIQUE (event_id, destination_id)'
  )
}

exports.down = (pgm) => {
  pgm.dropTable('deliveries')
}
