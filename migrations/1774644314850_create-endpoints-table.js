exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('endpoints', {
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
      type: 'varchar(255)',
      notNull: true,
    },
    public_token: {
      type: 'varchar(100)',
      notNull: true,
      unique: true,
    },
    is_active: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    metadata: {
      type: 'jsonb',
      default: '{}',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('endpoints', 'user_id')
  pgm.createIndex('endpoints', 'public_token')
}

exports.down = (pgm) => {
  pgm.dropTable('endpoints')
}
