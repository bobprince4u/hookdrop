import type { EntityManager } from 'typeorm'
import type { PgBoss, Db, Queue } from 'pg-boss'

/**
 * The queue contract: names, payload shapes, retry policy, and the transactional
 * publish path. Shared by every service that touches the queue.
 *
 * This file is a deliberate verbatim copy in `apps/worker`, `apps/ingestion` and
 * `apps/api`, following the convention `services/plan.service.ts` and the entity files
 * already use — until a shared package exists there is no way for one workspace to
 * import another's `src/`, and each service is built and deployed on its own
 * (`railway.json` per app, `tsc` with `rootDir: src`). The three copies are byte
 * identical on purpose; `scripts/check-queue-contract.ts` fails the build if they drift,
 * because a producer and a consumer that disagree about a queue name or a retry limit
 * fail silently — the job is written and nothing ever reads it, which is exactly the
 * H-04/H-09 shape of defect.
 *
 * Everything that differs per service lives in that service's `queue/index.ts`: the
 * worker migrates the schema, registers queues and consumes; the two producers only
 * publish.
 *
 * ## Why pg-boss
 *
 * The queue lives in the same Postgres database as the data it describes, so a job can
 * be inserted **inside the transaction that creates the row it refers to**. That is the
 * whole point of the migration: BullMQ could not do it. Ingestion committed an event and
 * then called `deliveryQueue.add()` as a separate network round trip, so a crash — or a
 * SIGTERM, or a Redis blip — in between left a committed event with no delivery work and
 * nothing recording that it had been lost (B-1). `publishDelivery` below takes the
 * TypeORM `EntityManager` of the caller's transaction, so either both the event and its
 * delivery job commit or neither does.
 *
 * Delivery remains **at-least-once**. pg-boss guarantees the job is durable and will be
 * retried; it cannot guarantee that an outbound HTTP request reaches a customer exactly
 * once, and nothing here pretends otherwise. The processor is written to be idempotent
 * instead: delivery rows move strictly forward through their states and terminal rows are
 * skipped, so a job delivered twice does not produce two logical delivery attempts.
 */

/**
 * Queue names.
 *
 * pg-boss has no separate job name — the queue *is* the name — so the two welcome-sequence
 * emails, which BullMQ distinguished by job name on a shared `email` queue, are now
 * distinguished by `EmailJob.template` on a single queue. That keeps one email consumer
 * with one concurrency bound, as before.
 */
export const QUEUES = {
  delivery: 'delivery',
  email: 'email',
  retention: 'retention',
  subscriptionExpiry: 'subscription-expiry',
  demoCleanup: 'demo-cleanup',
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

/**
 * Delivery job payload.
 *
 * Stable identifiers only. The processor re-reads the event, its destinations and their
 * secrets with narrow selects, so nothing sensitive is written to the queue: no user
 * record, no password hash, no destination secret, no request headers, and — importantly
 * for a `jsonb` column — no event body. A payload carrying the body would duplicate every
 * webhook in the queue table and put customer data somewhere with a different retention
 * policy than the `events` table it belongs to.
 *
 * `endpointId` is redundant with `event.endpoint_id` but is kept because the existing
 * processor signature takes both and the job rows already in flight carry both.
 *
 * `replay` is carried for logging only. It must not change any delivery control.
 */
export interface DeliveryJob {
  eventId: string
  endpointId: string
  replay?: boolean
}

export const EMAIL_TEMPLATES = ['day1-tips', 'day3-upgrade'] as const
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number]

/**
 * Email job payload.
 *
 * The recipient address is a demonstrated need — there is no way to send an email without
 * it — and it is not a secret in the sense §23 is about: it is not a credential, and the
 * `users` table already stores it. No API key, token or hash is ever placed here; the
 * Resend key is read from validated configuration by the consumer.
 */
export interface EmailJob {
  template: EmailTemplate
  email: string
  name: string
}

/** Cron-triggered sweeps take no payload; everything they need is configuration. */
export type ScheduledJob = Record<string, never>

/**
 * Per-destination attempt ceiling.
 *
 * This is the number a customer observes: four HTTP attempts per destination, counted on
 * the `deliveries` row, not on the job. It lives in the contract rather than only in the
 * processor because `DELIVERY_QUEUE.retryLimit` below has to be chosen against it.
 */
export const MAX_DELIVERY_ATTEMPTS = 4

/**
 * Queue definitions — the single place retry semantics are declared.
 *
 * pg-boss applies a queue's retry, expiry and retention settings to every job on it
 * unless a `send` overrides them, so producers pass no retry options at all. Under BullMQ
 * the same numbers were restated in three producer modules and could drift.
 *
 * ### Delivery
 *
 * BullMQ ran `attempts: 4` with `backoff: { type: 'exponential', delay: 5000 }` on the
 * job, while the processor independently allowed `MAX_DELIVERY_ATTEMPTS` per destination
 * off the `deliveries` row. Two counters for one thing, and they could disagree: add a
 * destination to an endpoint while its event is mid-retry and the new destination starts
 * at `attempt_count = 0` with only the job's remaining attempts to spend, so it is
 * stranded in `retrying` for ever once the job gives up. A job attempt burned on an
 * unrelated failure — a database blip before the first request — had the same effect on
 * every destination at once.
 *
 * The database is now authoritative. `retryLimit` is a backstop generous enough that the
 * per-destination ceiling is always what actually stops delivery, and the handler decides
 * whether to ask for another attempt by reading delivery rows, not by counting job runs.
 * When the backstop is nevertheless reached the handler writes that fact to the delivery
 * rows rather than leaving them non-terminal, so queue state and delivery state cannot
 * contradict each other.
 *
 * `retryDelay: 5` with `retryBackoff` reproduces BullMQ's 5 s exponential schedule.
 * `retryDelayMax` bounds the tail: without it the tenth retry would be ~11 hours out.
 *
 * `expireInSeconds` replaces BullMQ's `stalledInterval`/`maxStalledCount` stall
 * detection — a job held in `active` longer than this is retried, which is how a worker
 * killed mid-delivery is recovered. 15 minutes is the pg-boss default and is kept
 * explicit here because the arithmetic matters: a destination costs at most
 * `1 + MAX_REDIRECTS` requests at a 10 s timeout, so ~40 s, and destinations are
 * delivered sequentially. An endpoint with more than about 20 destinations could exceed
 * the window; the consequence is a retry, not a lost job, and the processor skips
 * destinations that already reached a terminal state.
 */
export const DELIVERY_QUEUE: Queue = {
  name: QUEUES.delivery,
  policy: 'standard',
  retryLimit: 10,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 300,
  expireInSeconds: 900,
}

/**
 * Email.
 *
 * `sendWelcomeSequence` schedules these 24 and 72 hours out, so a few widely spaced
 * retries are appropriate — a transient Resend outage should not consume all of them in
 * under a minute, which a 5 s backoff would.
 */
export const EMAIL_QUEUE: Queue = {
  name: QUEUES.email,
  policy: 'standard',
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  retryDelayMax: 3600,
  expireInSeconds: 120,
}

/**
 * Cron-triggered sweeps.
 *
 * Three of them, one queue each, because the two `node-cron` scheduler modules being
 * replaced registered three separate schedules between them: the hourly retention sweep,
 * the daily subscription expiry check, and the hourly demo-event cleanup that sits in
 * `subscription.scheduler.ts`. Separate queues keep their expiry windows and their
 * `exclusive` guarantees independent — a long retention run must not suppress the expiry
 * check.
 *
 * `retryLimit: 0` preserves the behaviour of the schedulers these replace: a failed run is
 * not retried, it waits for the next tick. All three sweeps are idempotent and frequent, so
 * retrying inside the interval buys nothing and risks two overlapping runs. In practice
 * their bodies already catch their own errors and resolve, so a retry would not be
 * triggered anyway; the setting states the intent.
 *
 * `policy: 'exclusive'` allows only one job queued *or* active per queue, which is the
 * property `node-cron` could not provide. `cron.schedule` runs in every process, so every
 * worker replica fired its own retention sweep on the same tick; they serialised on
 * `FOR UPDATE ... SKIP LOCKED` rather than corrupting anything, but the work was
 * duplicated. pg-boss schedules cluster-wide from the database, and `exclusive` means a
 * run that overruns its interval causes the next tick to be dropped instead of building a
 * backlog — the correct trade for an idempotent sweep.
 *
 * `expireInSeconds` is sized for the worst case each sweep permits: retention is bounded
 * by `RETENTION_BATCH_SIZE × RETENTION_MAX_BATCHES_PER_RUN` rows per plan tier, the expiry
 * check by one outbound email per affected user, and the demo cleanup by a single
 * statement against one endpoint.
 */
export const RETENTION_QUEUE: Queue = {
  name: QUEUES.retention,
  policy: 'exclusive',
  retryLimit: 0,
  expireInSeconds: 1800,
}

export const SUBSCRIPTION_EXPIRY_QUEUE: Queue = {
  name: QUEUES.subscriptionExpiry,
  policy: 'exclusive',
  retryLimit: 0,
  expireInSeconds: 600,
}

export const DEMO_CLEANUP_QUEUE: Queue = {
  name: QUEUES.demoCleanup,
  policy: 'exclusive',
  retryLimit: 0,
  expireInSeconds: 300,
}

/** Every queue this system uses. The worker registers all of them on start. */
export const ALL_QUEUES: readonly Queue[] = [
  DELIVERY_QUEUE,
  EMAIL_QUEUE,
  RETENTION_QUEUE,
  SUBSCRIPTION_EXPIRY_QUEUE,
  DEMO_CLEANUP_QUEUE,
]

/**
 * pg-boss keeps its tables in a schema of its own and owns the DDL for them entirely:
 * it installs and migrates them itself, `getConstructionPlans()` can print them, and
 * `npx pg-boss create|migrate|doctor` manages them from the command line. Nothing here
 * hand-writes that schema, `node-pg-migrate` keeps owning `public`, and TypeORM's
 * `synchronize` stays `false` in every service, so TypeORM never sees these tables at all.
 */
export const PGBOSS_SCHEMA = 'pgboss'

/**
 * pg-boss opens its own `pg` pool, separate from TypeORM's — the transactional publish
 * path borrows the caller's connection, but queue metadata, fetching and maintenance go
 * over pg-boss's own.
 *
 * That makes it a real addition to the connection budget, so it is kept deliberately
 * small rather than left at the `pg` default of 10. A publisher only reads cached queue
 * metadata, which two connections cover comfortably. No existing `DATABASE_POOL_MAX` is
 * raised to compensate: three services against one small managed instance is already the
 * constraint the TypeORM pools were bounded for. Against that, the worker gives up its
 * Redis connections entirely.
 */
export const PRODUCER_POOL_MAX = 2

export interface BossConnection {
  databaseUrl: string
  isProduction: boolean
  /** Shows up in `pg_stat_activity`, so a connection can be traced to a service. */
  applicationName: string
}

/**
 * TLS for managed Postgres, matching what each service's `DataSource` already does:
 * encrypted transport without authenticating the server, because managed providers
 * terminate TLS with a chain Node has no root for, and only when the URL does not
 * already say `sslmode=disable`.
 */
const bossSsl = (config: BossConnection): false | { rejectUnauthorized: boolean } =>
  config.isProduction && !/sslmode=disable/.test(config.databaseUrl)
    ? { rejectUnauthorized: false }
    : false

/**
 * A publish-only instance.
 *
 * Every background responsibility is switched off. `migrate` and `createSchema` are the
 * important ones: a producer must never install or alter the queue schema, both because
 * two services racing to migrate is a bad idea and because it means a producer started
 * against an uninstalled database fails immediately and loudly instead of quietly
 * creating tables nobody agreed to. `supervise` and `schedule` are the maintenance and
 * cron loops, which belong to the worker alone — left at their defaults, every API
 * replica would run them too.
 */
export const producerBossOptions = (config: BossConnection) => ({
  connectionString: config.databaseUrl,
  ssl: bossSsl(config),
  schema: PGBOSS_SCHEMA,
  max: PRODUCER_POOL_MAX,
  application_name: config.applicationName,
  migrate: false,
  createSchema: false,
  supervise: false,
  schedule: false,
})

/**
 * The consuming instance. Exactly one service runs this, and it owns the queue: schema
 * installation and migration, queue registration, the maintenance and cron loops, and
 * every handler.
 */
export const consumerBossOptions = (
  config: BossConnection & { poolMax: number }
) => ({
  connectionString: config.databaseUrl,
  ssl: bossSsl(config),
  schema: PGBOSS_SCHEMA,
  max: config.poolMax,
  application_name: config.applicationName,
  migrate: true,
  createSchema: true,
  supervise: true,
  schedule: true,
})

/**
 * Adapts a TypeORM `EntityManager` to the interface pg-boss uses for its own queries, so
 * a job insert can be enrolled in a transaction TypeORM is already running.
 *
 * pg-boss ships adapters for Knex, Kysely, Drizzle, Prisma and PGlite but not for
 * TypeORM, so this is the missing one. It is far simpler than the others: pg-boss emits
 * native `$1` placeholders and TypeORM passes them to `pg` untouched, so unlike the Knex
 * and Drizzle adapters there is no placeholder rewriting to get wrong.
 *
 * The `queryRunner` path asks TypeORM for a structured result and reads `.records`, which
 * is always the returned rows. The two-argument form would be wrong here: for `UPDATE`
 * and `DELETE` TypeORM returns `[rows, rowCount]` rather than `rows`, so a nested array
 * would reach pg-boss as its result set. Inside a transaction the manager always has a
 * `queryRunner`; the fallback exists only so a caller outside one still behaves.
 *
 * Only the job insert travels through here — pg-boss reads queue metadata over its own
 * pool — so this never sees multi-statement DDL.
 */
export const typeormDb = (manager: EntityManager): Db => ({
  async executeSql(text: string, values?: unknown[]) {
    const runner = manager.queryRunner

    if (runner) {
      const result = await runner.query(text, values as unknown[], true)
      return { rows: result.records ?? [] }
    }

    const rows = await manager.query(text, values as unknown[])
    return { rows: Array.isArray(rows) ? rows : [] }
  },
})

/**
 * Publishes a delivery job **inside the caller's transaction**.
 *
 * This is the fix for B-1 and the reason the migration is worth doing: pass the
 * `EntityManager` of the transaction that wrote the event, and the job row is written by
 * that same transaction. If it commits there is durable delivery work; if it rolls back
 * there is no orphan job. There is no window between the two and so no need for an outbox
 * table and sweeper to close one.
 *
 * It also removes the failure mode where the queue is unreachable while the database is
 * fine. The job is a row in the same database, inserted over the same connection, so a
 * pg-boss *process* being down cannot lose it — the work sits in `pgboss.job` and is
 * picked up when a worker returns. The remaining requirement is that the pg-boss schema
 * and this queue exist before the caller starts, which `assertQueuesExist` checks at boot.
 *
 * `group` bounds the fan-out: with `groupConcurrency: 1` on the consumer, pg-boss will not
 * run two jobs for the same event at the same time anywhere in the cluster, so a replay
 * enqueued while the original job is still active cannot race it into double delivery.
 */
export const publishDelivery = async (
  boss: PgBoss,
  manager: EntityManager,
  data: DeliveryJob
): Promise<string | null> =>
  boss.send(QUEUES.delivery, data, {
    db: typeormDb(manager),
    group: { id: data.eventId },
  })

/**
 * Publishes an email job, optionally delayed.
 *
 * No transaction: the welcome sequence is sent after registration has already committed
 * and is explicitly fire-and-forget — a mail failure must not fail registration. That is
 * the pre-existing contract and it is preserved rather than tightened, because a delayed
 * marketing email is not delivery work anyone is owed.
 */
export const publishEmail = async (
  boss: PgBoss,
  data: EmailJob,
  options: { startAfterSeconds?: number } = {}
): Promise<string | null> =>
  boss.send(QUEUES.email, data, {
    ...(options.startAfterSeconds !== undefined
      ? { startAfter: options.startAfterSeconds }
      : {}),
  })

/**
 * Fails fast when a queue this service publishes to has not been registered.
 *
 * `boss.start()` already refuses to run against a database where the pg-boss schema is
 * missing or needs migrating, but it does not check individual queues, and a `send` to an
 * unregistered queue throws. For ingestion that would mean accepting a webhook and then
 * failing the request — or worse, rolling back an event a provider has been told nothing
 * about. Checking at boot turns a per-request 500 into a refusal to start, which matches
 * how this codebase already treats invalid configuration.
 */
export const assertQueuesExist = async (
  boss: PgBoss,
  names: readonly string[]
): Promise<void> => {
  const missing: string[] = []

  for (const name of names) {
    const queue = await boss.getQueue(name)
    if (!queue) missing.push(name)
  }

  if (missing.length > 0) {
    throw new Error(
      `pg-boss queues not registered: ${missing.join(', ')}. ` +
        'The worker registers queues on start; run it, or `npx pg-boss create`, ' +
        'before starting this service.'
    )
  }
}
