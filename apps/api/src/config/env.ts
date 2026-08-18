import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Single source of truth for API configuration.
 *
 * Two rules this module exists to enforce:
 *  1. No fallback secrets. A missing or weak signing key aborts boot instead of
 *     silently accepting tokens anyone can forge (H-01).
 *  2. No silent insecure defaults. Infrastructure URLs are never guessed; the
 *     process refuses to start rather than quietly connecting to localhost (H-09).
 *
 * Nothing in here logs a value — only variable names (H-48).
 */

/**
 * Locate the nearest `.env` by walking up from this module rather than resolving
 * against `process.cwd()`, which breaks under any process manager that starts
 * the app from a different directory (H-44).
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

/** Values that were previously hardcoded fallbacks, or are obvious placeholders. */
const FORBIDDEN_SECRETS = new Set([
  'fallback_secret',
  'fallback_refresh',
  'secret',
  'changeme',
  'change_me',
  'password',
  'test',
  'development',
])

const MIN_SECRET_LENGTH = IS_PRODUCTION ? 32 : 16

const signingSecret = (label: string) =>
  z
    .string()
    .min(
      MIN_SECRET_LENGTH,
      `${label} must be at least ${MIN_SECRET_LENGTH} characters`
    )
    .refine((value) => !FORBIDDEN_SECRETS.has(value.toLowerCase()), {
      message: `${label} is a known placeholder value and must be replaced`,
    })

/**
 * Redis and Postgres URLs are required outright in production. In development we
 * still require them explicitly — defaulting to localhost is what let the API
 * connect to a non-existent queue without anyone noticing (H-09).
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

const optionalNonEmpty = z
  .string()
  .trim()
  .min(1)
  .optional()
  .catch(undefined)

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),

    PORT: z.coerce.number().int().positive().max(65535).default(3003),

    DATABASE_URL: requiredUrl('DATABASE_URL', ['postgres', 'postgresql']),

    /** Postgres pool ceiling per process. Three services share one instance. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: requiredUrl('REDIS_URL', ['redis', 'rediss']),

    JWT_SECRET: signingSecret('JWT_SECRET'),
    REFRESH_TOKEN_SECRET: signingSecret('REFRESH_TOKEN_SECRET'),
    ACCESS_TOKEN_TTL: z.string().trim().min(1).default('15m'),
    REFRESH_TOKEN_TTL: z.string().trim().min(1).default('30d'),

    FRONTEND_URL: optionalNonEmpty,
    EXTRA_ORIGINS: optionalNonEmpty,
    INGESTION_URL: optionalNonEmpty,

    SENTRY_DSN: optionalNonEmpty,
    // 100% trace sampling in production is a cost and performance problem (H-43).
    SENTRY_TRACES_SAMPLE_RATE: z.coerce
      .number()
      .min(0)
      .max(1)
      .default(IS_PRODUCTION ? 0.1 : 1),

    GEMINI_API_KEY: optionalNonEmpty,

    RESEND_API_KEY: optionalNonEmpty,
    EMAIL_FROM: optionalNonEmpty,
    ADMIN_EMAIL: optionalNonEmpty,

    DEFAULT_PAYMENT_PROVIDER: z
      .enum(['paystack', 'flutterwave', 'stripe'])
      .default('paystack'),

    PAYSTACK_SECRET_KEY: optionalNonEmpty,
    FLUTTERWAVE_SECRET_KEY: optionalNonEmpty,
    // Flutterwave does not sign payloads; it sends a shared secret in `verif-hash`
    // which must be compared against this value (H-05).
    FLUTTERWAVE_SECRET_HASH: optionalNonEmpty,
    STRIPE_SECRET_KEY: optionalNonEmpty,
    STRIPE_WEBHOOK_SECRET: optionalNonEmpty,

    /**
     * Naira per US dollar, used to price the Stripe checkout session.
     *
     * The default reproduces the rate that was hardcoded in the Stripe provider,
     * so pricing does not change on deploy — but it is now visible, auditable and
     * correctable without a code change (H-36, H-39).
     */
    NGN_PER_USD: z.coerce.number().positive().max(100_000).default(1600),

    ADMIN_EMAILS: optionalNonEmpty,

    DEMO_PUBLIC_TOKEN: z.string().trim().min(1).default('demo-hookdrop-live-2024'),
    DEMO_RETENTION_HOURS: z.coerce.number().int().positive().default(1),

    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET === env.REFRESH_TOKEN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        message:
          'JWT_SECRET and REFRESH_TOKEN_SECRET must be different values, otherwise a refresh token is accepted as an access token',
        path: ['REFRESH_TOKEN_SECRET'],
      })
    }

    // The configured default provider must actually be usable, otherwise the
    // first upgrade attempt fails at runtime instead of at boot.
    const providerCredential: Record<string, string | undefined> = {
      paystack: env.PAYSTACK_SECRET_KEY,
      flutterwave: env.FLUTTERWAVE_SECRET_KEY,
      stripe: env.STRIPE_SECRET_KEY,
    }
    const requiredCredential = providerCredential[env.DEFAULT_PAYMENT_PROVIDER]
    if (IS_PRODUCTION && !requiredCredential) {
      ctx.addIssue({
        code: 'custom',
        message: `DEFAULT_PAYMENT_PROVIDER is "${env.DEFAULT_PAYMENT_PROVIDER}" but its secret key is not configured`,
        path: ['DEFAULT_PAYMENT_PROVIDER'],
      })
    }

    /**
     * A configured provider with no way to verify webhooks can only ever fail closed,
     * and that is exactly what both providers do — `flutterwave.provider.ts:82` and
     * `stripe.provider.ts:98` return `valid: false` when the secret is absent, so an
     * unverifiable callback is rejected, never trusted.
     *
     * In production that silent rejection is worse than refusing to boot: payments
     * would be taken and never granted. So it stays a hard error there. In development
     * it must not be — a developer holding a test provider key cannot receive callbacks
     * locally anyway, and aborting boot over it made the service unstartable. Warned
     * once after parsing instead.
     */
    if (
      IS_PRODUCTION &&
      env.FLUTTERWAVE_SECRET_KEY &&
      !env.FLUTTERWAVE_SECRET_HASH
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'FLUTTERWAVE_SECRET_KEY is set but FLUTTERWAVE_SECRET_HASH is missing; Flutterwave webhooks cannot be verified without it',
        path: ['FLUTTERWAVE_SECRET_HASH'],
      })
    }
    if (IS_PRODUCTION && env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        message:
          'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing; Stripe webhooks cannot be verified without it',
        path: ['STRIPE_WEBHOOK_SECRET'],
      })
    }

    if (IS_PRODUCTION && !env.FRONTEND_URL) {
      ctx.addIssue({
        code: 'custom',
        message:
          'FRONTEND_URL is required in production to build the CORS allow-list',
        path: ['FRONTEND_URL'],
      })
    }
  })

export type ApiEnv = z.infer<typeof envSchema>

const parseEnv = (): ApiEnv => {
  const result = envSchema.safeParse({
    ...process.env,
    PORT: process.env.PORT ?? process.env.API_PORT,
  })

  if (!result.success) {
    // Report names and reasons only. Never echo the offending value (H-48).
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(root)'
      return `  - ${name}: ${issue.message}`
    })
    console.error(
      [
        'Invalid API configuration. Refusing to start.',
        ...problems,
        '',
        'See .env.example for the full list of required variables.',
      ].join('\n')
    )
    process.exit(1)
  }

  return result.data
}

export const env: ApiEnv = parseEnv()

/**
 * Non-fatal configuration warnings, emitted once at import.
 *
 * Only reachable outside production, where the equivalent checks in `superRefine`
 * are hard errors. Names only, never values (H-48).
 */
const warnUnverifiableWebhooks = (): void => {
  const missing: string[] = []
  if (env.FLUTTERWAVE_SECRET_KEY && !env.FLUTTERWAVE_SECRET_HASH) {
    missing.push('FLUTTERWAVE_SECRET_HASH')
  }
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    missing.push('STRIPE_WEBHOOK_SECRET')
  }
  if (missing.length > 0) {
    console.warn(
      `Config warning: ${missing.join(', ')} not set. Webhooks for the affected provider will be rejected, so payments cannot be confirmed until it is configured.`
    )
  }
}

warnUnverifiableWebhooks()

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/** Redis connections must opt into TLS for `rediss://` URLs (H-38). */
export const redisTlsOptions = (): { tls?: Record<string, never> } =>
  env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}

/**
 * Emails allowed to reach admin-only routes, lower-cased (H-07).
 *
 * `ADMIN_EMAIL` (singular) is read as a fallback because it was the original variable
 * and is still the one deployed: `routes/index.ts` compares against raw
 * `process.env.ADMIN_EMAIL` and `email.service.ts` reads `env.ADMIN_EMAIL`, while
 * `requireAdmin` reads only `ADMIN_EMAILS`. That three-way split is why every admin
 * route 403s for everyone today. Accepting both here makes the readers agree without
 * requiring a config change first; `routes/index.ts` is switched over to `requireAdmin`
 * in the same pass (H-31).
 *
 * Both variables accept a comma-separated list, so a deployment that sets either one
 * — or both — resolves to the same allow-list.
 */
export const adminEmails = (): ReadonlySet<string> =>
  new Set(
    [env.ADMIN_EMAILS, env.ADMIN_EMAIL]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => value.split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  )
