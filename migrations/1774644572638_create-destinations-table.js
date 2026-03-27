exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('destinations', {
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
    url: {
      type: 'varchar(2048)',
      notNull: true,
    },
    secret: {
      type: 'varchar(255)',
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('destinations', 'endpoint_id')
}

exports.down = (pgm) => {
  pgm.dropTable('destinations')
}
