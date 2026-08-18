import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Single source of truth for ingestion configuration.
 *
 * The ingestion service previously read `process.env` directly from four modules, each
 * calling `dotenv.config({ path: '../../.env' })` for itself. That path is relative to
 * `process.cwd()`, so it only resolved when the process happened to be started from
 * `apps/ingestion` — under any process manager that sets a different working directory
 * the file was simply not found, every variable was undefined, and the fallbacks took
 * over silently (H-44).
 *
 * The most damaging fallback was `REDIS_URL || 'redis://localhost:6379'`: in a hosted
 * deployment that connects to nothing, so events were accepted, saved, and never
 * queued for delivery (H-09, H-38).
 *
 * Nothing here logs a value — only variable names (H-48).
 */

/**
 * Locate the nearest `.env` by walking up from this module rather than resolving against
 * `process.cwd()`. Mirrors `apps/api/src/config/env.ts`.
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

/**
 * Required outright, in every environment. Defaulting an infrastructure URL to
 * localhost is the failure this service is being fixed for.
 */
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
 * Resend's shared sandbox sender, hardcoded as the `From` address in this service's email
 * module. It only delivers to the address that owns the Resend account, so in production
 * every plan-limit warning was silently dropped for every other recipient (H-31).
 */
const SANDBOX_SENDER = 'onboarding@resend.dev'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().max(65535).default(3002),

  DATABASE_URL: requiredUrl('DATABASE_URL', ['postgres', 'postgresql']),

  /** Three services share one Postgres instance, so each caps its own pool. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: requiredUrl('REDIS_URL', ['redis', 'rediss']),

  SENTRY_DSN: optionalNonEmpty,
  /**
   * Was hardcoded to `1.0` here while the API honoured this variable and defaulted to
   * 0.1 in production — leaving the highest-volume service of the three as the one
   * tracing every single request (H-43).
   */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(IS_PRODUCTION ? 0.1 : 1),

  /** Used to build the Socket.IO CORS allow-list, replacing `origin: '*'` (H-41). */
  FRONTEND_URL: optionalNonEmpty,
  EXTRA_ORIGINS: optionalNonEmpty,

  RESEND_API_KEY: optionalNonEmpty,
  EMAIL_FROM: optionalNonEmpty,

  /**
   * Number of proxy hops in front of this service. The rate limiter keys on
   * `req.params.token` rather than the IP, but `req.ip` is still recorded on every
   * event, and an unset value records the proxy's address for every request (H-19).
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  /**
   * Largest inbound webhook accepted, in bytes. `express.text({ type: '*[/]*' })` was
   * mounted with no limit, so it fell back to the 100kb default silently — a bound
   * nobody chose and nobody could see (H-32).
   */
  MAX_INGEST_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(256 * 1024),
})
  .superRefine((value, ctx) => {
    if (!IS_PRODUCTION) return

    if (!value.FRONTEND_URL) {
      ctx.addIssue({
        code: 'custom',
        message:
          'FRONTEND_URL is required in production to build the Socket.IO origin allow-list',
        path: ['FRONTEND_URL'],
      })
    }

    if (value.EMAIL_FROM?.includes(SANDBOX_SENDER)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'EMAIL_FROM must not use the Resend sandbox sender in production; it only delivers to the account owner',
        path: ['EMAIL_FROM'],
      })
    }
  })

export type IngestionEnv = z.infer<typeof envSchema>

const parseEnv = (): IngestionEnv => {
  const result = envSchema.safeParse({
    ...process.env,
    PORT: process.env.PORT ?? process.env.INGESTION_PORT,
  })

  if (!result.success) {
    // Names and reasons only. Never echo the offending value (H-48).
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)'
      return `  - ${name}: ${issue.message}`
    })
    console.error(
      [
        'Invalid ingestion configuration. Refusing to start.',
        ...problems,
        '',
        'See .env.example for the full list of required variables.',
      ].join('\n')
    )
    process.exit(1)
  }

  return result.data
}

export const env: IngestionEnv = parseEnv()

export const isProduction = env.NODE_ENV === 'production'

/** Redis connections must opt into TLS for `rediss://` URLs (H-38). */
export const redisTlsOptions = (): { tls?: Record<string, never> } =>
  env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}

/**
 * Sender for outbound mail (H-31).
 *
 * Falls back to the sandbox sender only outside production, where it is genuinely useful:
 * a developer without a verified domain still gets mail at their own address. In
 * production the schema above has already rejected it.
 */
export const emailFrom = (): string =>
  env.EMAIL_FROM ?? `Hookdrop <${SANDBOX_SENDER}>`

/** Base URL for links in email templates, interpolated as `${frontendUrl()}/dashboard`. */
export const frontendUrl = (): string =>
  (env.FRONTEND_URL ?? 'http://localhost:3004').replace(/\/$/, '')

/**
 * Origins allowed to open a Socket.IO connection to this service.
 *
 * Replaces `cors: { origin: '*' }`, which contradicted the allow-list the API already
 * enforces (H-12, H-41). The same three defaults as `apps/api/src/index.ts` are included
 * deliberately: the dashboard connects to both services, so a list that differed between
 * them would fail for whichever one was missing an entry.
 */
export const allowedOrigins = (): Set<string> =>
  new Set(
    [
      'http://localhost:3004',
      'https://hookdropi.vercel.app',
      'https://hookdropi.qzz.io',
      env.FRONTEND_URL,
      ...(env.EXTRA_ORIGINS?.split(',') ?? []),
    ]
      .map((value) => value?.trim().replace(/\/$/, ''))
      .filter((value): value is string => Boolean(value))
  )
