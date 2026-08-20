import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Single source of truth for worker configuration.
 *
 * Four modules here each called `dotenv.config({ path: '../../.env' })` for themselves.
 * That path resolves against `process.cwd()`, so it only found the file when the process
 * was started from `apps/worker`; under any process manager with a different working
 * directory nothing was loaded and every fallback took over silently (H-44).
 *
 * The consequences in this service were not subtle:
 *
 *   - `REDIS_URL || 'redis://localhost:6379'` — the worker connected to a Redis that does
 *     not exist in a hosted deployment, so no queued delivery was ever consumed (H-09).
 *     `REDIS_URL` is gone from this schema entirely: the queue is Postgres now, and this
 *     service holds no Redis connection of any kind.
 *   - `process.env.FRONTEND_URL` is interpolated into seven email templates, which
 *     rendered every dashboard link as `undefined/dashboard`.
 *   - `tracesSampleRate: 1.0`, hardcoded, traced every operation in production (H-43).
 *
 * Nothing here logs a value — only variable names (H-48).
 */

const loadDotEnv = (): void => {
  let dir = __dirname
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate })
      return
    }
    const parent = path.dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

loadDotEnv()

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

const requiredUrl = (label: string, protocols: string[]) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol.replace(':', ''))
        } catch {
          return false
        }
      },
      { message: `${label} must be a URL using one of: ${protocols.join(', ')}` }
    )

const optionalNonEmpty = z.string().trim().min(1).optional().catch(undefined)

/**
 * `"false"` is a non-empty string, so `z.coerce.boolean()` would read it as `true` — which
 * for an off switch on a job that deletes data is the wrong direction to be wrong in.
 *
 * An unrecognised value is left for `z.boolean()` to reject rather than being guessed at, so
 * `RETENTION_ENABLED=maybe` refuses to boot instead of silently picking a side.
 */
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

const booleanFlag = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    if (TRUTHY.has(normalized)) return true
    if (FALSY.has(normalized)) return false
    return value
  }, z.boolean())

/**
 * Resend's shared sandbox sender.
 *
 * It only delivers to the address that owns the Resend account, so in production every
 * subscription reminder and delivery-failure notice was silently dropped for every other
 * recipient — and this service is the one that sends subscription mail (H-31).
 */
const SANDBOX_SENDER = 'onboarding@resend.dev'

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    DATABASE_URL: requiredUrl('DATABASE_URL', ['postgres', 'postgresql']),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(5),

    /**
     * Size of the pool pg-boss opens for itself, separate from TypeORM's.
     *
     * pg-boss borrows the caller's connection when a job is published inside a
     * transaction, but its own fetching, completion and maintenance queries need
     * connections of their own. Four covers polling plus completions at the default
     * `DELIVERY_CONCURRENCY`; it is configurable because this is the one service whose
     * queue traffic scales with throughput, and deliberately small because the reason
     * `DATABASE_POOL_MAX` is bounded — three services against one managed instance —
     * applies to this pool too. It is a separate variable rather than an increase to
     * `DATABASE_POOL_MAX` so the two budgets stay legible.
     */
    PGBOSS_POOL_MAX: z.coerce.number().int().min(1).max(50).default(4),

    SENTRY_DSN: optionalNonEmpty,
    SENTRY_TRACES_SAMPLE_RATE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(IS_PRODUCTION ? 0.1 : 1),

    /** Interpolated into every outbound email template. */
    FRONTEND_URL: optionalNonEmpty,

    RESEND_API_KEY: optionalNonEmpty,
    EMAIL_FROM: optionalNonEmpty,

    /** How many delivery jobs this worker processes at once. */
    DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    EMAIL_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),

    /**
     * The demo endpoint whose events are pruned hourly. Was a bare UUID literal inside a
     * raw SQL string in the scheduler; the default preserves that exact value.
     *
     * `guid` rather than `uuid`, which would reject the default it is guarding. Zod 4's
     * `uuid()` enforces the RFC 9562 version and variant nibbles, and this literal has
     * neither — it is a hand-written sentinel, not a generated v4. The default is not
     * validated (Zod returns it without re-parsing), so the mismatch is invisible until
     * someone sets `DEMO_ENDPOINT_ID` explicitly to the documented value, at which point
     * the worker refuses to boot. `guid()` checks the shape, which is the whole
     * requirement: this value is interpolated into a `WHERE endpoint_id = $1`, so what
     * matters is that Postgres can cast it.
     */
    DEMO_ENDPOINT_ID: z
      .string()
      .guid()
      .default('00000000-0000-0000-0000-000000000002'),
    DEMO_RETENTION_HOURS: z.coerce.number().int().positive().default(1),

    /**
     * Per-plan event retention (H-18).
     *
     * `RETENTION_ENABLED` exists because this is the only scheduled job that destroys
     * customer data: an operator who sees it removing more than expected needs a way to stop
     * it that does not require a code change and a redeploy.
     *
     * The two bounds together cap one hourly run at `BATCH_SIZE × MAX_BATCHES` rows *per plan
     * tier*, so with the defaults a single run removes at most 100 000 events per tier and
     * says in the log when it stopped early. Raising them shortens the drain of a first-run
     * backlog at the cost of a longer-held transaction and more cascade work per statement.
     */
    RETENTION_ENABLED: booleanFlag(true),
    RETENTION_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(100)
      .max(50_000)
      .default(5_000),
    RETENTION_MAX_BATCHES_PER_RUN: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(20),

    /** Local timezone for the daily scheduler, so "9am" means one specific instant. */
    SCHEDULER_TIMEZONE: z.string().trim().min(1).default('UTC'),
  })
  .superRefine((value, ctx) => {
    if (!IS_PRODUCTION) return

    if (!value.FRONTEND_URL) {
      ctx.addIssue({
        code: 'custom',
        message:
          'FRONTEND_URL is required in production; email templates interpolate it into every dashboard link',
        path: ['FRONTEND_URL'],
      })
    }

    if (!value.EMAIL_FROM) {
      ctx.addIssue({
        code: 'custom',
        message:
          'EMAIL_FROM is required in production; the Resend sandbox sender only delivers to the account owner',
        path: ['EMAIL_FROM'],
      })
    } else if (value.EMAIL_FROM.includes(SANDBOX_SENDER)) {
      ctx.addIssue({
        code: 'custom',
        message: `EMAIL_FROM must not use the Resend sandbox sender in production; it only delivers to the account owner. Set a sender on a domain you have verified.`,
        path: ['EMAIL_FROM'],
      })
    }
  })

export type WorkerEnv = z.infer<typeof envSchema>

const parseEnv = (): WorkerEnv => {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)'
      return `  - ${name}: ${issue.message}`
    })
    console.error(
      [
        'Invalid worker configuration. Refusing to start.',
        ...problems,
        '',
        'See .env.example for the full list of required variables.',
      ].join('\n')
    )
    process.exit(1)
  }

  return result.data
}

export const env: WorkerEnv = parseEnv()

export const isProduction = env.NODE_ENV === 'production'

/**
 * Sender for outbound mail.
 *
 * Falls back to the sandbox sender only outside production, where it is genuinely useful:
 * a developer without a verified domain still gets mail delivered to their own address.
 * In production the schema above has already rejected it.
 */
export const emailFrom = (): string =>
  env.EMAIL_FROM ?? `Hookdrop <${SANDBOX_SENDER}>`

/** Base URL for links in email templates. */
export const frontendUrl = (): string =>
  (env.FRONTEND_URL ?? 'http://localhost:3004').replace(/\/$/, '')
