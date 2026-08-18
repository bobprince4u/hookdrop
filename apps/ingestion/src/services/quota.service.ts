import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { redis } from '../queue'
import {
  currentMonthKeyUtc,
  secondsUntilNextMonthUtc,
  startOfCurrentMonthUtc,
} from './plan.service'

/**
 * Monthly event quota accounting (H-21, H-47).
 *
 * Every single inbound webhook used to run
 *
 *   SELECT COUNT(*) FROM events JOIN endpoints … WHERE user_id = $1 AND received_at >= $2
 *
 * on the hot path, before the event was even written. That is an index scan over every
 * event the account has received this month, on the busiest code path in the system, purely
 * to decide whether to allow one row — so the cost of accepting a webhook grew linearly
 * with how many webhooks the account had already received that month.
 *
 * Postgres stays authoritative. Redis is a short-lived cache in front of it, with two
 * properties that matter:
 *
 *  - **Self-healing.** The cached value carries a 60-second TTL and is re-derived from
 *    Postgres on every miss, so an evicted key, a failover, or drift from any source is
 *    corrected within a minute rather than persisting for the rest of the month.
 *  - **Fail-closed.** If Redis is unreachable, every call falls back to counting in
 *    Postgres. Quota enforcement degrades in latency, never in correctness — the one
 *    behaviour a metering path must not have is becoming permissive when its cache breaks.
 *
 * Known and bounded: two requests arriving within the same cache window can both read a
 * usage figure one below the limit and both be admitted, overshooting by up to the number
 * of concurrent requests. The `COUNT(*)` version had exactly the same race — reading a
 * count and acting on it is not atomic either way — and the ingest rate limiter caps how
 * wide the window can be. Closing it completely would mean a serialisable transaction or a
 * DB-side constraint around every insert, which is a much larger change to the hot path
 * than the overshoot justifies.
 */

/**
 * 60 seconds: long enough that a busy endpoint stops re-counting per request, short enough
 * that the reported usage a user sees is never meaningfully stale and any drift is
 * self-correcting well inside the month it applies to.
 */
const CACHE_TTL_SECONDS = 60

const usageKey = (userId: string): string =>
  `quota:events:${userId}:${currentMonthKeyUtc()}`

const warningKey = (userId: string): string =>
  `quota:warned:${userId}:${currentMonthKeyUtc()}`

/**
 * The authority. Counts events already committed this month, from the UTC month boundary —
 * the local-time boundary this replaces is H-21's actual defect, documented in
 * `plan.service.ts`.
 */
const countStoredEventsThisMonth = async (userId: string): Promise<number> =>
  AppDataSource.getRepository(Event)
    .createQueryBuilder('event')
    .innerJoin('event.endpoint', 'ep')
    .where('ep.user_id = :userId', { userId })
    .andWhere('event.received_at >= :monthStart', {
      monthStart: startOfCurrentMonthUtc(),
    })
    .getCount()

/**
 * Events stored for this user in the current UTC month, excluding the request in flight.
 *
 * Never throws on a cache failure: an unreachable Redis falls through to the authority.
 */
export const readMonthlyUsage = async (userId: string): Promise<number> => {
  const key = usageKey(userId)

  try {
    const cached = await redis.get(key)
    if (cached !== null) {
      const parsed = Number(cached)
      // A non-numeric or negative value means something else wrote this key. Ignore it
      // and re-derive rather than admitting traffic on a value we cannot interpret.
      if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
    }
  } catch (error) {
    console.error(
      'Quota cache read failed, falling back to Postgres:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }

  const stored = await countStoredEventsThisMonth(userId)

  try {
    await redis.set(key, String(stored), 'EX', CACHE_TTL_SECONDS)
  } catch {
    // The cache is an optimisation. Losing it costs latency, not correctness.
  }
  return stored
}

/**
 * Records that one event was committed.
 *
 * Called only after a successful insert, which is what keeps the counter from inflating on
 * rejected requests — a counter incremented before the limit check would climb every time a
 * blocked sender retried, and would still be inflated after the user upgraded to a plan
 * whose limit they had never actually reached.
 *
 * `INCR` preserves the key's TTL, so the 60-second reconcile window set by
 * `readMonthlyUsage` still applies.
 */
export const recordEventStored = async (userId: string): Promise<void> => {
  const key = usageKey(userId)

  try {
    const next = await redis.incr(key)

    if (next === 1) {
      /**
       * The key expired between the read and this increment, so `1` is not the real total
       * and — because `INCR` creates keys without one — it now has no expiry either.
       * Reseed from the authority. The event is already committed, so this count includes
       * it.
       */
      const stored = await countStoredEventsThisMonth(userId)
      await redis.set(key, String(stored), 'EX', CACHE_TTL_SECONDS)
    }
  } catch (error) {
    /**
     * Swallowed deliberately. The event is already persisted and queued; failing the
     * request now would tell the sender to retry a webhook that was in fact accepted, and
     * duplicate delivery is a worse outcome than a usage figure that is one low for up to
     * a minute — the next cache miss re-derives it from Postgres regardless.
     */
    console.error(
      'Quota counter increment failed:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

/**
 * Claims the right to send this month's plan-limit warning. True at most once per user per
 * UTC month, across every ingestion instance.
 *
 * This is the other half of H-47. The threshold test was `count + 1 === warningThreshold` —
 * exact equality against a live `COUNT(*)`:
 *
 *  - two events arriving concurrently could straddle the value and never equal it, so the
 *    warning was skipped for the whole month;
 *  - any burst that stepped from below the threshold to above it in one request did the
 *    same;
 *  - and because the count was recomputed from scratch each time, deleting events dragged
 *    it back below the threshold so the warning fired *again* on the way back up.
 *
 * Replacing equality with `>=` fixes the skip but would then re-send on every subsequent
 * event, which is why the latch is not optional. `SET … NX` makes the claim atomic, so
 * concurrent requests cannot both win it.
 *
 * The key expires when the UTC month does — the same boundary the quota itself uses, so the
 * warning becomes available again exactly when the allowance it warns about resets.
 */
export const claimLimitWarning = async (userId: string): Promise<boolean> => {
  try {
    const result = await redis.set(
      warningKey(userId),
      '1',
      'EX',
      secondsUntilNextMonthUtc(),
      'NX'
    )
    return result === 'OK'
  } catch (error) {
    /**
     * Fail closed on *sending*. With Redis down there is no way to know whether this
     * warning has already gone out, and the failure mode of guessing wrong is one warning
     * email per inbound webhook.
     */
    console.error(
      'Could not claim plan-limit warning latch:',
      error instanceof Error ? error.message : 'unknown error'
    )
    return false
  }
}
