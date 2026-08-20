/**
 * Canonical plan catalogue for the worker service.
 *
 * A copy of `apps/api/src/services/plan.service.ts` — the same convention this service's
 * entity files already follow, since until Stage H's `packages/shared` exists there is no way
 * for one workspace to import another's `src/`. Only this header comment differs between the
 * three copies; **the exported surface is identical in all of them**, deliberately, because
 * the retention job in this service and the quota check in the ingestion service must agree
 * about what a plan entitles a user to. Two catalogues that disagreed would delete data the
 * other believed it was still storing.
 *
 * `retention_hours` had no reader anywhere in the monorepo before this service acquired one
 * (H-18): the numbers were published on the marketing page, promised in the welcome email,
 * and enforced by nothing.
 */

export type PlanId = 'free' | 'starter' | 'pro' | 'team'

export interface PlanDefinition {
  readonly id: PlanId
  readonly name: string
  /** Price in the currency's MAJOR unit (naira, not kobo). */
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
   * No reader in this service — it is enforced at the ingestion edge. It is carried here
   * because the three catalogues are kept identical on purpose: a field present in two copies
   * and absent from the third is exactly the drift this convention exists to prevent, and the
   * next person to add a plan would have to notice the omission to reproduce it.
   */
  readonly ingest_per_minute: number
}

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
 * A paid `plan` column with a `plan_expires_at` in the past is not an entitlement (H-14,
 * H-29). A null `plan_expires_at` on a paid plan is treated as expired, not perpetual, so a
 * cancellation cannot read as a never-expiring upgrade (H-30).
 *
 * Note for the retention job specifically: it does **not** use this function. See
 * `schedulers/retention.scheduler.ts` for why deleting data on the strength of a computed
 * entitlement is the wrong side of an irreversible operation to be clever on.
 */
export const resolveEffectivePlan = (user: {
  plan: string | null | undefined
  plan_expires_at?: Date | string | null
}): PlanDefinition => {
  const claimed = isPlanId(user.plan) ? user.plan : 'free'

  if (claimed === 'free') {
    return PLANS.free
  }

  const expiresAt = user.plan_expires_at ? new Date(user.plan_expires_at) : null

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

/** `YYYY-MM` in UTC — the cache-key suffix for the quota counter. */
export const currentMonthKeyUtc = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

/** Seconds until the next UTC month begins, for keys that must not outlive the window. */
export const secondsUntilNextMonthUtc = (now: Date = new Date()): number => {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000))
}
