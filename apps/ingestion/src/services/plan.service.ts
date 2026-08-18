/**
 * Canonical plan catalogue for the ingestion service.
 *
 * This is a deliberate verbatim copy of `apps/api/src/services/plan.service.ts`, following
 * the same convention the entity files in this service already use — they are line-for-line
 * copies of the API's. Stage H's `packages/shared` collapses all of them; until a shared
 * package exists there is no way for one workspace to import another's `src/`.
 *
 * What it replaces is worse than a copy. `routes/ingest.ts` carried the event limits
 * **twice** — once as a module-level `PLAN_LIMITS` and again as an inline literal inside
 * the request handler, forty lines apart — and the two had already drifted apart in shape
 * (`{ events_per_month: n }` vs a bare `n`). Together with `apps/api`'s
 * `middleware/planLimits.ts` that made four independent copies of the same numbers, so
 * changing a published limit required finding all four (H-26, H-36).
 *
 * Only this header comment differs between the copies; keep the **exported surface**
 * identical in all of them. A partial copy is how drift starts.
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
  },
}

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value)

/**
 * The plan a user is actually entitled to right now.
 *
 * This service never consulted `plan_expires_at` at all: it read the `plan` column
 * directly, so a lapsed Team subscriber kept ingesting at 500 000 events/month
 * indefinitely, and the worker's nightly downgrade was the only thing that ever
 * corrected it — hours late, and not at all if that job failed (H-29).
 *
 * A null `plan_expires_at` on a paid plan is treated as expired, not perpetual.
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

/**
 * UTC month boundary (H-21).
 *
 * The counter this replaces built its boundary with `setDate(1); setHours(0,0,0,0)`, which
 * is local time. Three consequences, all of them live:
 *
 *  - the quota window started at a different instant depending on the host's timezone, so
 *    the API and the ingestion service disagreed about how many events a user had used;
 *  - west of UTC the window opened *late*, so events from the first hours of the month
 *    were counted against the previous month — which had already been billed;
 *  - `setDate(1)` on a date whose day-of-month exceeds the target month's length rolls
 *    over, and `setHours` mutates the same object it reads, so the two calls are
 *    order-dependent on a value that is already wrong.
 */
export const startOfCurrentMonthUtc = (now: Date = new Date()): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))

/**
 * `YYYY-MM` in UTC — the cache-key suffix for the quota counter.
 *
 * Deriving it from the same UTC boundary above is what keeps the counter and the window it
 * counts in agreement: a key that rolled over at a different instant than the `COUNT(*)`
 * it reconciles against would reconcile to the wrong month's total.
 */
export const currentMonthKeyUtc = (now: Date = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

/** Seconds until the next UTC month begins, for keys that must not outlive the window. */
export const secondsUntilNextMonthUtc = (now: Date = new Date()): number => {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000))
}
