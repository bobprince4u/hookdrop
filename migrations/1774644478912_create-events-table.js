exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    endpoint_id: {
      type: 'uuid',
      notNull: true,
      references: '"endpoints"',
      onDelete: 'CASCADE',
    },
    method: {
      type: 'varchar(10)',
      notNull: true,
      default: 'POST',
    },
    headers: {
      type: 'jsonb',
      notNull: true,
      default: '{}',
    },
    body: {
      type: 'text',
    },
    source_ip: {
      type: 'varchar(45)',
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
      default: 'received',
    },
    received_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('events', 'endpoint_id')
  pgm.createIndex('events', 'received_at')
  pgm.createIndex('events', 'status')
}

exports.down = (pgm) => {
  pgm.dropTable('events')
}
