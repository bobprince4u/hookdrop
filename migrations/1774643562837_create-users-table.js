exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true })

  pgm.createTable('users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    email: {
      type: 'varchar(255)',
      notNull: true,
      unique: true,
    },
    name: {
      type: 'varchar(255)',
      notNull: true,
    },
    password_hash: {
      type: 'varchar(255)',
      notNull: true,
    },
    plan: {
      type: 'varchar(50)',
      notNull: true,
      default: 'free',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('users', 'email')
}

exports.down = (pgm) => {
  pgm.dropTable('users')
}
