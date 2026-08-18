import { z } from 'zod'
import { PLAN_IDS } from '../services/plan.service'
import { literalUrlRejectionReason } from '../services/url-guard'

/**
 * Request validation schemas.
 *
 * Every bound here exists because the previous code had none: pagination was
 * unclamped (H-20), AI parameters flowed straight into a `varchar(50)` cache key
 * and into a model prompt (H-22), destination URLs were accepted verbatim (H-02),
 * and registration accepted any string as a password (H-25).
 *
 * Existing query-parameter names are preserved so no client has to change.
 */

/**
 * bcrypt truncates silently at 72 bytes, so anything longer is a false sense of
 * security. Reject rather than pre-hash, which would invalidate existing hashes.
 */
export const BCRYPT_MAX_PASSWORD_BYTES = 72

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= BCRYPT_MAX_PASSWORD_BYTES,
    {
      message: `Password must be at most ${BCRYPT_MAX_PASSWORD_BYTES} bytes; bcrypt ignores anything beyond that`,
    }
  )
  .refine((value) => /[a-z]/.test(value) && /[A-Z]/.test(value), {
    message: 'Password must contain both lower and upper case letters',
  })
  .refine((value) => /\d/.test(value), {
    message: 'Password must contain at least one digit',
  })

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('A valid email address is required'))

export const registerSchema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Name is required').max(120),
  password: passwordSchema,
})

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately not `passwordSchema`: tightening the policy must not lock out
  // existing accounts whose password predates it.
  password: z.string().min(1, 'Password is required').max(1024),
})

/** Accepted from a cookie normally; body is kept only for non-browser clients. */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(512).optional(),
})

/**
 * Page-based pagination, matching the response shape the dashboard already reads.
 * `limit` is hard-capped: `?limit=1000000` used to be a one-request outage (H-20).
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const EVENT_STATUSES = [
  'received',
  'delivering',
  'delivered',
  'failed',
  'dead_letter',
] as const

/** Search is bounded so it cannot be used to force an unbounded pattern scan. */
export const eventQuerySchema = paginationSchema.extend({
  status: z.enum(EVENT_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(200).optional(),
})
export type EventQuery = z.infer<typeof eventQuerySchema>

export const planSchema = z.enum(PLAN_IDS)

export const initializePaymentSchema = z.object({
  plan: planSchema,
  provider: z.enum(['paystack', 'flutterwave', 'stripe']).optional(),
})

export const adminUpgradeSchema = z.object({
  email: emailSchema,
  plan: planSchema,
  /** Bounded so a typo cannot grant a century of free service. */
  days: z.coerce.number().int().min(1).max(730).default(90),
})

export const adminUserQuerySchema = paginationSchema.extend({
  plan: z.enum([...PLAN_IDS, 'all']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
})
export type AdminUserQuery = z.infer<typeof adminUserQuerySchema>

/**
 * `general` is in this list because `components/FeedbackWidget.tsx` offers exactly three
 * categories — Bug, Feature, General — and `general` is the default selection. An enum of
 * `bug | feature | question | other` would have 400'd the most common submission the
 * product makes, which is how mounting a validator can break a working feature: the schema
 * has to describe the client that exists, not the one it would have been nice to have.
 * `question` and `other` are kept for direct API callers.
 */
export const feedbackSchema = z.object({
  type: z.enum(['bug', 'feature', 'general', 'question', 'other']),
  message: z.string().trim().min(1, 'Message is required').max(5000),
})

/**
 * Closed enumerations, not free text. These values become part of a cache key on
 * a `varchar(50)` column and are interpolated into a model prompt, so an open
 * string was both a truncation bug and a prompt-injection vector (H-22).
 */
export const AI_LANGUAGES = [
  'typescript',
  'javascript',
  'python',
  'go',
  'ruby',
  'php',
  'java',
  'csharp',
  'rust',
] as const

export const AI_FRAMEWORKS = [
  'express',
  'fastify',
  'nextjs',
  'nestjs',
  'flask',
  'django',
  'fastapi',
  'rails',
  'laravel',
  'gin',
  'spring',
  'aspnet',
  'axum',
] as const

export const generateHandlerSchema = z.object({
  language: z.enum(AI_LANGUAGES).default('typescript'),
  framework: z.enum(AI_FRAMEWORKS).default('express'),
})
export type GenerateHandlerInput = z.infer<typeof generateHandlerSchema>

export const uuidSchema = z.uuid('A valid id is required')

/** Route params that carry ids. Rejects non-uuid text before it reaches Postgres. */
export const endpointParamsSchema = z.object({ id: uuidSchema })
export const eventParamsSchema = z.object({ id: uuidSchema, eId: uuidSchema })
export const destinationParamsSchema = z.object({
  id: uuidSchema,
  dId: uuidSchema,
})

export const createEndpointSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
})

/**
 * Free-form endpoint metadata.
 *
 * The old update handler assigned `req.body.metadata` straight onto the entity, which
 * is why mass assignment was live on that path (H-32): the column is `jsonb`, so
 * anything at all could be stored, at any size. Setting metadata is intentional
 * product behaviour though, so this keeps the capability and bounds it instead of
 * removing it — a jsonb column with no size limit is a cheap way to fill a disk.
 */
export const endpointMetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'metadata is limited to 50 keys',
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 8_192,
    { message: 'metadata is limited to 8 KB' }
  )

/**
 * Unknown keys are stripped rather than rejected, and the handler assigns only the
 * three fields below by name. Two independent barriers, because the failure being
 * prevented — a request quietly setting `user_id` or `public_token` — is a tenancy
 * break, not a validation nicety.
 *
 * `description` is deliberately absent: no such column exists on `endpoints`, so
 * accepting the field would have stored nothing while returning 200.
 */
export const updateEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
    metadata: endpointMetadataSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  })

/**
 * Destination URL shape check.
 *
 * This is only the syntactic half of SSRF defence. It rejects non-HTTP schemes, URLs
 * carrying credentials, private and reserved address *literals*, and the handful of
 * local hostnames users paste by accident.
 *
 * The authoritative check is `assertPublicUrl` in the worker, immediately before the
 * connection: DNS can be repointed after the destination is saved, and redirects have to
 * be re-validated per hop, so no write-time check can be the control (H-02).
 *
 * The previous version of this comment described exactly the behaviour above while the
 * code below tested `url.protocol` and nothing else — `http://localhost/` and
 * `http://169.254.169.254/` both passed it — and the worker it deferred to contained no
 * SSRF code at all. The rules now live in `services/url-guard.ts`, shared with the
 * runtime check so the two cannot disagree about what "private" means.
 */
export const destinationUrlSchema = z
  .string()
  .trim()
  .min(1, 'URL is required')
  .max(2048)
  .superRefine((value, ctx) => {
    const reason = literalUrlRejectionReason(value)
    if (reason) {
      // The specific reason is surfaced: a user who pasted a localhost URL should be
      // told that, not given a generic "invalid URL".
      ctx.addIssue({ code: 'custom', message: reason })
    }
  })

export const createDestinationSchema = z.object({
  url: destinationUrlSchema,
  secret: z.string().trim().min(16).max(255).optional(),
})

export const demoFireSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16_384,
    { message: 'Demo payloads are limited to 16 KB' }
  )

/**
 * API-key creation (H-27).
 *
 * `name` is capped at the `varchar(100)` the column actually holds, so a long label is
 * rejected with a 400 rather than truncated by Postgres or failing as a 500.
 *
 * `expires_in_days` is optional because a key with no expiry is a legitimate choice for a
 * long-lived server integration, and forcing a value would only produce a wrong one. The
 * ceiling matches `adminUpgradeSchema.days` for the same reason: a mistyped expiry should not
 * create a credential that outlives anyone's memory of issuing it. The service enforces the
 * same bound, since it can also be called from outside a validated route.
 */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(100),
  expires_in_days: z.coerce.number().int().min(1).max(730).optional(),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>

export const apiKeyParamsSchema = z.object({ id: uuidSchema })
