/**
 * Canonical plan catalogue.
 *
 * Before this file the same numbers were written out four times — in
 * `billing.controller.ts`, in `middleware/planLimits.ts` (since deleted — it was also
 * fail-open, calling `next()` from its own error handler), in the ingestion service, and
 * again as an inline literal further down the same ingestion function — with the inline
 * copy already having drifted (H-26, H-36). Everything server-side now reads from here.
 *
 * Values match what the marketing page and billing page advertise; changing a
 * number here changes enforcement everywhere.
 */

export type PlanId = 'free' | 'starter' | 'pro' | 'team'

export interface PlanDefinition {
  readonly id: PlanId
  readonly name: string
  /**
   * Price in the currency's MAJOR unit (naira, not kobo).
   *
   * The Paystack provider multiplies by 100 before charging, so treating this as
   * kobo would under-charge by 100x. Webhook amount verification converts per
   * provider rather than assuming a shared unit (H-06).
   */
  readonly amount: number
  readonly currency: 'NGN'
  readonly events: number
  readonly retention_hours: number
  /** `null` means unlimited, as advertised. */
  readonly endpoints: number | null
  readonly ai_enabled: boolean
  /**
   * Inbound webhooks per minute accepted across one account's ingest URLs.
   *
   * Enforced by the ingestion service, not this one, but published here because this file is
   * the catalogue: the billing page reads these definitions to describe what a plan buys, and
   * a rate that is enforced somewhere and documented nowhere is how the hardcoded 60/minute
   * survived across every tier in the first place (S-3).
   */
  readonly ingest_per_minute: number
}

/** Declared as a const tuple so `z.enum(PLAN_IDS)` stays type-safe. */
export const PLAN_IDS = ['free', 'starter', 'pro', 'team'] as const satisfies
  readonly PlanId[]

export const PLANS: Readonly<Record<PlanId, PlanDefinition>> = {
  free: {
    id: 'free',
    name: 'Free',
    amount: 0,
    currency: 'NGN',
    events: 500,
    retention_hours: 24,
    endpoints: 2,
    ai_enabled: false,
    ingest_per_minute: 60,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    amount: 7500,
    currency: 'NGN',
    events: 10000,
    retention_hours: 168,
    endpoints: 5,
    ai_enabled: true,
    ingest_per_minute: 300,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    amount: 19000,
    currency: 'NGN',
    events: 100000,
    retention_hours: 720,
    endpoints: null,
    ai_enabled: true,
    ingest_per_minute: 1200,
  },
  team: {
    id: 'team',
    name: 'Team',
    amount: 49000,
    currency: 'NGN',
    events: 500000,
    retention_hours: 2160,
    endpoints: null,
    ai_enabled: true,
    ingest_per_minute: 3000,
  },
}

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)

/**
 * The plan a user is actually entitled to right now.
 *
 * A paid `plan` column with a `plan_expires_at` in the past is not an entitlement.
 * Previously nothing in the request path consulted `plan_expires_at`, so expired
 * subscriptions kept full access indefinitely (H-14, H-29), and cancellation —
 * which nulls the column — was an upgrade to a never-expiring paid plan (H-30).
 *
 * A null `plan_expires_at` on a paid plan is treated as expired, not perpetual.
 * Grants that are meant to be open-ended must set an explicit future date.
 */
export const resolveEffectivePlan = (user: {
  plan: string | null | undefined
  plan_expires_at?: Date | string | null
}): PlanDefinition => {
  const claimed = isPlanId(user.plan) ? user.plan : 'free'

  if (claimed === 'free') {
    return PLANS.free
  }

  const expiresAt = user.plan_expires_at
    ? new Date(user.plan_expires_at)
    : null

  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return PLANS.free
  }

  return expiresAt.getTime() > Date.now() ? PLANS[claimed] : PLANS.free
}

/** True when the stored plan is paid but no longer active. */
export const isPlanExpired = (user: {
  plan: string | null | undefined
  plan_expires_at?: Date | string | null
}): boolean =>
  isPlanId(user.plan) &&
  user.plan !== 'free' &&
  resolveEffectivePlan(user).id === 'free'

/** UTC month boundary. Local-time boundaries shifted the quota window (H-21). */
export const startOfCurrentMonthUtc = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))

/**
 * `YYYY-MM` in UTC — the cache-key suffix for the quota counter.
 *
 * Present in this copy as well as the ingestion service's, and that is the point: the
 * ingestion service increments the counter and the API reads it back for the dashboard's
 * usage figure. A key derived from a boundary computed differently in the two services would
 * have them reporting different totals for the same month, which is the H-21 defect one
 * layer up.
 */
export const currentMonthKeyUtc = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

/** Seconds until the next UTC month begins, for keys that must not outlive the window. */
export const secondsUntilNextMonthUtc = (now: Date = new Date()): number => {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000))
}
