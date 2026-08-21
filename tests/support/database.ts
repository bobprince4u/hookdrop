import './env'

import { Pool } from 'pg'
import type { PoolClient } from 'pg'

/**
 * Fixtures and assertions for the test database, over a raw `pg` pool.
 *
 * Deliberately not TypeORM. The suites assert on what is actually in the tables — that a
 * job row exists after a commit and does not after a rollback, that `attempt_count` moved,
 * that `response_body` was cleared by a replay — and reading those through the same entity
 * definitions the code under test writes them with would hide a mapping error from both
 * sides at once. `Destination.secret` carries `select: false`, so a TypeORM read would not
 * even return the column a signing test needs. SQL sees the row.
 *
 * `pg` is a root-hoisted dependency, so this module resolves it without belonging to any
 * workspace. `typeorm` is not hoisted — each service installs its own — which is why
 * nothing under `tests/` imports it directly; where a suite needs an `EntityManager` it
 * gets one from that service's own `AppDataSource`.
 */

/**
 * A `TRUNCATE` against a database someone is working in is unrecoverable, and the only
 * thing standing between the two is an environment variable. So the name is checked here,
 * against the URL the pool was actually built from, immediately before the statement runs —
 * not once at import, and not against the constant in `env.ts`, which an operator can
 * override from the shell.
 *
 * The convention is a suffix rather than an allow-list of one name so that a second test
 * database (a scratch copy, a parallel CI run) needs no change here.
 */
const TEST_DATABASE_SUFFIX = '_test'

const databaseNameOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  } catch {
    return ''
  }
}

const assertTestDatabase = (): string => {
  const url = process.env.DATABASE_URL ?? ''
  const name = databaseNameOf(url)

  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to modify database "${name || '(unparseable DATABASE_URL)'}": ` +
        `the test suites truncate every table they touch, so the name must end in ` +
        `"${TEST_DATABASE_SUFFIX}". Create one with ` +
        `\`createdb hookdrop_test\` and apply the migrations to it.`
    )
  }

  return name
}

let pool: Pool | null = null

export const db = (): Pool => {
  if (!pool) {
    assertTestDatabase()
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      /**
       * Four, not the two the services are configured with. `withRolledBackTransaction`
       * holds one connection open for the length of a lock-contention test while the
       * assertions run on another, and a pool that can only just accommodate that turns a
       * mistake in a test into a hang on connection acquisition rather than a failure.
       */
      max: 4,
      connectionTimeoutMillis: 5_000,
    })
  }
  return pool
}

export const closeDatabase = async (): Promise<void> => {
  if (!pool) return
  const closing = pool
  pool = null
  await closing.end()
}

/** One row, or `undefined`. Saves every caller writing `.rows[0]`. */
export const one = async <T>(
  text: string,
  values: unknown[] = []
): Promise<T | undefined> => {
  const result = await db().query(text, values)
  return result.rows[0] as T | undefined
}

export const all = async <T>(
  text: string,
  values: unknown[] = []
): Promise<T[]> => {
  const result = await db().query(text, values)
  return result.rows as T[]
}

export const count = async (
  text: string,
  values: unknown[] = []
): Promise<number> => {
  const row = await one<{ n: string }>(text, values)
  return Number(row?.n ?? 0)
}

/**
 * Empties the application tables.
 *
 * The list is read from the catalogue rather than hardcoded, so a migration that adds a
 * table does not leave a suite silently inheriting rows from the previous one.
 * `pgmigrations` is excluded: dropping the migration history would make the database look
 * unmigrated to the next run, and it holds no test data.
 *
 * One statement with `CASCADE` because the foreign keys form a chain — a user owns
 * endpoints, which own events and destinations, which own deliveries — and truncating them
 * separately would either fail on the references or depend on getting the order right.
 */
export const resetTables = async (): Promise<void> => {
  assertTestDatabase()

  const tables = await all<{ name: string }>(
    `select tablename as name
       from pg_tables
      where schemaname = 'public'
        and tablename <> 'pgmigrations'`
  )

  if (tables.length === 0) {
    throw new Error(
      `The test database has no application tables. Apply the migrations first: ` +
        `\`DATABASE_URL=$TEST_DATABASE_URL npx node-pg-migrate up --migrations-dir migrations\`` +
        ` (node-pg-migrate reads DATABASE_URL from .env, which overrides --database-url).`
    )
  }

  const quoted = tables
    .map((t) => `public."${t.name.replace(/"/g, '""')}"`)
    .join(', ')
  await db().query(`truncate ${quoted} restart identity cascade`)
}

/**
 * Empties the queue.
 *
 * `job` only, which in pg-boss 12 is the whole of it: there is no `archive` table any more.
 * A terminal job stays in `job` with its final state until `deletion_seconds` — seven days
 * by default — and is then deleted outright, so the unbounded growth that an
 * `removeOnComplete`-less BullMQ queue produced has no equivalent here. `job` is a
 * partitioned table, so truncating it clears every partition.
 *
 * `queue`, `schedule` and `version` are pg-boss's own registry and are left alone: the queue
 * rows carry the partition mapping and retry policy that `startQueue()` installed, the
 * version row is the schema migration state, and truncating either would leave the instance
 * describing a queue whose storage no longer exists. Jobs are the test data; the schema is
 * not. Suites that install cron schedules clear them with `resetSchedules()`.
 *
 * Called only when the schema is present, so a suite that never starts the queue does not
 * fail on a missing table.
 */
export const resetQueue = async (): Promise<void> => {
  assertTestDatabase()
  if (!(await queueSchemaPresent())) return
  await db().query('truncate pgboss.job')
}

/** Cron registrations, which outlive a `truncate pgboss.job`. */
export const resetSchedules = async (): Promise<void> => {
  assertTestDatabase()
  if (!(await queueSchemaPresent())) return
  await db().query('truncate pgboss.schedule')
}

const queueSchemaPresent = async (): Promise<boolean> => {
  const row = await one<{ present: boolean }>(
    `select exists (
       select 1 from pg_tables where schemaname = 'pgboss' and tablename = 'job'
     ) as present`
  )
  return Boolean(row?.present)
}

export const reset = async (): Promise<void> => {
  await resetQueue()
  await resetTables()
}

/**
 * Fixtures.
 *
 * Every one takes overrides and returns the generated id, so a test names only the column
 * it is about. Emails and tokens are suffixed with a per-process counter because several
 * fixtures in one suite would otherwise collide on the unique constraints, and `node --test`
 * runs each file in its own process so a counter is enough.
 */
let seq = 0
const unique = (): number => {
  seq += 1
  return seq
}

/**
 * Not a hash of anything. `password_hash` is `NOT NULL` and no suite authenticates, so this
 * is a placeholder chosen to be unmistakable in a dump rather than a bcrypt digest that
 * would read like a leaked credential.
 */
const PLACEHOLDER_PASSWORD_HASH = 'not-a-real-hash-test-fixture-only'

export interface UserFixture {
  email?: string
  name?: string
  plan?: string
  planExpiresAt?: Date | null
  lastReminderSentAt?: Date | null
}

export const createUser = async (
  fixture: UserFixture = {}
): Promise<string> => {
  const n = unique()
  const row = await one<{ id: string }>(
    `insert into users (email, name, password_hash, plan, plan_expires_at, last_reminder_sent_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      fixture.email ?? `user-${n}@example.invalid`,
      fixture.name ?? `Test User ${n}`,
      PLACEHOLDER_PASSWORD_HASH,
      fixture.plan ?? 'free',
      fixture.planExpiresAt ?? null,
      fixture.lastReminderSentAt ?? null,
    ]
  )
  return row!.id
}

export interface EndpointFixture {
  userId: string
  id?: string
  name?: string
  publicToken?: string
  isActive?: boolean
}

export const createEndpoint = async (
  fixture: EndpointFixture
): Promise<string> => {
  const n = unique()
  const row = await one<{ id: string }>(
    `insert into endpoints (id, user_id, name, public_token, is_active)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5)
     returning id`,
    [
      fixture.id ?? null,
      fixture.userId,
      fixture.name ?? `Endpoint ${n}`,
      fixture.publicToken ?? `token-${n}-${process.pid}`,
      fixture.isActive ?? true,
    ]
  )
  return row!.id
}

export interface DestinationFixture {
  endpointId: string
  url?: string
  secret?: string | null
  isActive?: boolean
}

export const createDestination = async (
  fixture: DestinationFixture
): Promise<string> => {
  const row = await one<{ id: string }>(
    `insert into destinations (endpoint_id, url, secret, is_active)
     values ($1, $2, $3, $4)
     returning id`,
    [
      fixture.endpointId,
      fixture.url ?? 'https://93.184.216.34/hook',
      fixture.secret ?? null,
      fixture.isActive ?? true,
    ]
  )
  return row!.id
}

export interface EventFixture {
  endpointId: string
  method?: string
  headers?: Record<string, string>
  body?: string | null
  sourceIp?: string | null
  status?: string
  receivedAt?: Date
}

export const createEvent = async (fixture: EventFixture): Promise<string> => {
  const row = await one<{ id: string }>(
    `insert into events (endpoint_id, method, headers, body, source_ip, status, received_at)
     values ($1, $2, $3::jsonb, $4, $5, $6, coalesce($7::timestamptz, now()))
     returning id`,
    [
      fixture.endpointId,
      fixture.method ?? 'POST',
      JSON.stringify(fixture.headers ?? { 'content-type': 'application/json' }),
      fixture.body ?? '{"hello":"world"}',
      fixture.sourceIp ?? '198.51.100.7',
      fixture.status ?? 'received',
      fixture.receivedAt ?? null,
    ]
  )
  return row!.id
}

export interface DeliveryFixture {
  eventId: string
  destinationId: string
  attemptCount?: number
  status?: string
  responseCode?: number | null
  responseBody?: string | null
  lastAttemptedAt?: Date | null
  deliveredAt?: Date | null
}

export const createDelivery = async (
  fixture: DeliveryFixture
): Promise<string> => {
  const row = await one<{ id: string }>(
    `insert into deliveries (event_id, destination_id, attempt_count, status,
                             response_code, response_body, last_attempted_at, delivered_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      fixture.eventId,
      fixture.destinationId,
      fixture.attemptCount ?? 0,
      fixture.status ?? 'pending',
      fixture.responseCode ?? null,
      fixture.responseBody ?? null,
      fixture.lastAttemptedAt ?? null,
      fixture.deliveredAt ?? null,
    ]
  )
  return row!.id
}

/**
 * A whole endpoint with one destination and one event, which is what most suites need.
 */
export interface ScenarioOptions {
  plan?: string
  destinationUrl?: string
  destinationSecret?: string | null
  destinations?: number
}

export interface Scenario {
  userId: string
  endpointId: string
  destinationIds: string[]
  eventId: string
}

export const createScenario = async (
  options: ScenarioOptions = {}
): Promise<Scenario> => {
  const userId = await createUser({ plan: options.plan })
  const endpointId = await createEndpoint({ userId })

  const total = options.destinations ?? 1
  const destinationIds: string[] = []
  for (let i = 0; i < total; i += 1) {
    destinationIds.push(
      await createDestination({
        endpointId,
        url: options.destinationUrl ?? `https://93.184.216.34/hook-${i}`,
        secret: options.destinationSecret ?? null,
      })
    )
  }

  const eventId = await createEvent({ endpointId })

  return { userId, endpointId, destinationIds, eventId }
}

/**
 * Runs `work` inside a transaction on a dedicated connection and then rolls it back, so a
 * suite can observe what a statement holds a lock on — or prove that concurrent work
 * skipped a locked row — without leaving anything behind.
 */
export const withRolledBackTransaction = async <T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await db().connect()
  try {
    await client.query('begin')
    return await work(client)
  } finally {
    await client.query('rollback').catch(() => undefined)
    client.release()
  }
}
