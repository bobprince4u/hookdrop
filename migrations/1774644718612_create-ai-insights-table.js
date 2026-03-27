exports.shorthands = undefined

exports.up = (pgm) => {
  pgm.createTable('ai_insights', {
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
    insight_type: {
      type: 'varchar(50)',
      notNull: true,
    },
    content: {
      type: 'text',
      notNull: true,
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })

  pgm.createIndex('ai_insights', 'event_id')
  pgm.createIndex('ai_insights', ['event_id', 'insight_type'])
  pgm.addConstraint(
    'ai_insights',
    'ai_insights_event_type_unique',
    'UNIQUE (event_id, insight_type)'
  )
}

exports.down = (pgm) => {
  pgm.dropTable('ai_insights')
}
