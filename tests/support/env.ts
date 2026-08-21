/**
 * Test configuration, applied before any application module is loaded.
 *
 * Every service reads its configuration through a Zod schema in `src/config/env.ts` that
 * calls `dotenv.config()` at import time and then `process.exit(1)` if the result does not
 * validate. Two consequences shape this file:
 *
 *  1. **It has to run first.** Once `config/env.ts` has been imported, `env` is a frozen
 *     parse of whatever `process.env` held at that moment, so setting a variable afterwards
 *     changes nothing. Every test file imports this module — directly, or through
 *     `./database` and `./queue`, which both import it — as its first statement, and the
 *     `test` script also preloads it with `--require` so ordering inside a file cannot
 *     silently break the guarantee.
 *  2. **Assignment wins over `.env`.** `dotenv.config()` defaults to `override: false` and
 *     decides with `hasOwnProperty`, so a variable already present in `process.env` is left
 *     alone — including one set to the empty string. That is what lets the blanking below
 *     work: an empty string is not "unset, fall back to .env", it is "present and empty",
 *     which every optional field in those schemas resolves to `undefined`.
 *
 * ## Why the credentials are blanked
 *
 * The repository `.env` is a working development file: it holds a real Sentry DSN, a real
 * Resend key, a real Gemini key and real payment provider keys. Nothing in a test suite
 * should be able to reach any of them. A delivery-failure notification that actually sent
 * mail, or a handler error that actually filed a Sentry event, would be a test with a side
 * effect outside the machine it ran on — so each one is explicitly emptied here rather than
 * left to the accident of whether the code path happens to be exercised.
 *
 * The network boundary the delivery processor uses is stubbed per test instead (see
 * `tests/worker/*.test.ts`), because the SSRF guard correctly refuses to connect to any
 * address a test could bind locally.
 */

/** Set only if absent, so an operator can point a suite elsewhere from the shell. */
const provide = (name: string, value: string): void => {
  if (process.env[name] === undefined) process.env[name] = value
}

/** Set unconditionally: these must not come from `.env`. */
const force = (name: string, value: string): void => {
  process.env[name] = value
}

/**
 * The suites truncate every table they touch, so the target must never be a database
 * anyone is using. `database.ts` re-checks the name it actually connects to before issuing
 * a `TRUNCATE`; this is the other half of the same guard, and the reason the default is a
 * separate database rather than the development one with a different schema.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/hookdrop_test'

/**
 * Redis is not used by the worker at all after the queue migration. It is set because the
 * API and ingestion schemas require it to parse — their Socket.IO adapter and rate-limiter
 * stores need it — and it points at database 15 so a suite that does touch it cannot
 * collide with development keys in database 0.
 */
export const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379/15'

force('NODE_ENV', 'test')
force('DATABASE_URL', TEST_DATABASE_URL)
force('REDIS_URL', TEST_REDIS_URL)

/**
 * Distinct from each other by construction: the API schema rejects a configuration where
 * `JWT_SECRET === REFRESH_TOKEN_SECRET`, because a refresh token would then be accepted as
 * an access token. Both are well over the 16-character development minimum and neither is
 * on the placeholder blocklist.
 */
force('JWT_SECRET', 'test-access-token-signing-key-0000')
force('REFRESH_TOKEN_SECRET', 'test-refresh-token-signing-key-1111')

/**
 * Small pools. Three services and a test runner against one local instance, and
 * `node --test` gives every test file its own process, so several of these pools can exist
 * at once. Two connections is enough for a suite that runs its fixtures sequentially, and
 * pg-boss needs its own for fetching and completion.
 */
provide('DATABASE_POOL_MAX', '2')
provide('PGBOSS_POOL_MAX', '2')

/** Nothing outbound. See the note above. */
force('SENTRY_DSN', '')
force('SENTRY_TRACES_SAMPLE_RATE', '0')
force('RESEND_API_KEY', '')
force('GEMINI_API_KEY', '')
force('PAYSTACK_SECRET_KEY', '')
force('FLUTTERWAVE_SECRET_KEY', '')
force('FLUTTERWAVE_SECRET_HASH', '')
force('STRIPE_SECRET_KEY', '')
force('STRIPE_WEBHOOK_SECRET', '')

/**
 * Deterministic values for the two things that read configuration rather than the database:
 * the demo endpoint the hourly cleanup prunes, and the timezone the daily scheduler
 * resolves "9am" against.
 */
provide('FRONTEND_URL', 'http://localhost:3004')
provide('EMAIL_FROM', 'Hookdrop Tests <tests@example.invalid>')
provide('SCHEDULER_TIMEZONE', 'UTC')
provide('DEMO_ENDPOINT_ID', '00000000-0000-0000-0000-000000000002')
provide('DEMO_RETENTION_HOURS', '1')
