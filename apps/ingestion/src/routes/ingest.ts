import { Router, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { getBoss } from '../queue'
import { publishDelivery } from '../queue/contract'
import { emitNewEvent } from '../socket'
import { ingestRateLimiter } from '../middleware/rateLimiter'
import { resolveEndpoint, ingestContext } from '../middleware/resolveEndpoint'
import { redactSensitiveHeaders } from '../services/headers.util'
import {
  claimLimitWarning,
  readMonthlyUsage,
  recordEventStored,
} from '../services/quota.service'
import { sendPlanLimitWarningEmail } from '../services/email.service'

const router = Router()

/**
 * Webhook capture — the hot path of the whole system.
 *
 * Seven findings converged on this one handler, and they are listed here because several of
 * them were invisible while the others stood:
 *
 * - **B-1.** A committed event could end up with no delivery work at all: the insert
 *   committed, and only then was a job pushed to Redis as a separate round trip. See the
 *   comment on the transaction below — this is the finding the whole queue migration exists
 *   to fix, and the only one here that silently dropped customer webhooks.
 * - **H-26 / H-36.** The plan limits were written out twice inside this file: a module-level
 *   `PLAN_LIMITS` keyed `{ events_per_month }`, and a second inline literal forty lines
 *   further down keyed as a bare number. The inline copy had already drifted in shape, and
 *   the line that used it had been commented out — leaving `limit` bound to the *other*
 *   copy by coincidence of scope. Both are gone; `services/plan.service.ts` is the single
 *   source.
 * - **H-29.** Entitlement was read straight off `user.plan` with no reference to
 *   `plan_expires_at`, so a lapsed subscription kept its paid quota until the worker's
 *   nightly downgrade happened to run. `resolveEffectivePlan` is now consulted at the edge,
 *   in `middleware/resolveEndpoint.ts`.
 * - **H-21.** The month boundary was local time, and the count was a fresh `COUNT(*)` over
 *   every event in the month on every request.
 * - **H-47.** The 80% warning used exact equality against that count, so it was skipped
 *   entirely by any burst that stepped over the value, and re-sent when deletions dragged
 *   the count back down.
 * - **H-17.** `req.headers` was stored verbatim, persisting whatever credentials the sender
 *   put in `Authorization`, `Cookie`, or a signature header.
 *
 * The endpoint lookup that used to open this handler now lives in `resolveEndpoint`, which
 * runs before the rate limiter so the limiter can read the account's plan. It is the same
 * single query, moved — not an additional one.
 */

/**
 * Sends the 80%-of-quota warning, at most once per user per month.
 *
 * Runs *after* the response has been sent. Previously an `await` on Resend sat between
 * storing the event and answering the sender, so on the one request that crossed the
 * threshold the provider waited on a third-party email API — and providers treat a slow
 * webhook endpoint as a failing one.
 */
const warnIfApproachingLimit = async (
  user: { id: string; email: string; name: string },
  used: number,
  limit: number
): Promise<void> => {
  // Floor, matching what the dashboard displays as the warning point.
  const threshold = Math.floor(limit * 0.8)
  if (used < threshold) return

  // Atomic: concurrent requests cannot both claim it, and it stays claimed for the month.
  if (!(await claimLimitWarning(user.id))) return

  try {
    await sendPlanLimitWarningEmail(user.email, user.name, used, limit)
  } catch (error) {
    console.error(
      `Plan limit warning failed for user ${user.id}:`,
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

const handleIngest = async (req: Request, res: Response): Promise<void> => {
  const token = req.params.token as string

  try {
    /**
     * Already loaded and validated by `resolveEndpoint`, which also answered 404 for an
     * unknown token, a disabled endpoint or a deleted owner — so by here the endpoint exists,
     * is active, has an owner, and the owner's effective plan is known.
     */
    const { id: endpointId, userId, user, plan } = ingestContext(req)

    const limit = plan.events
    const used = await readMonthlyUsage(userId)

    if (used >= limit) {
      /**
       * The plan tier and the usage figures are deliberately *not* in this response. The
       * ingest URL's only credential is the token in it, so anyone who has ever seen a
       * capture URL — every provider it was pasted into, every log that recorded it — could
       * read the account's subscription tier and traffic volume out of a 429. The details
       * that are actually useful for debugging are logged server-side instead.
       */
      console.warn(
        `Ingest rejected for user ${userId}: ${used}/${limit} events used on the ${plan.id} plan`
      )
      res.status(429).json({ error: 'Monthly event limit reached' })
      return
    }

    const eventRepo = AppDataSource.getRepository(Event)

    const event = eventRepo.create({
      endpoint_id: endpointId,
      method: req.method,
      /**
       * Redacted before it is ever written (H-17). This is the durable half of the fix —
       * the API's read-side redaction covers rows captured before this deployed.
       */
      headers: redactSensitiveHeaders(req.headers),
      /**
       * `express.text({ type: '*[/]*' })` hands us a string for every content type, so the
       * `JSON.stringify` fallback only fires for a request with no body at all, where it
       * would otherwise store the literal `undefined`.
       */
      body: typeof req.body === 'string' ? req.body : null,
      source_ip: req.ip,
      status: 'received',
    })

    /**
     * The event and its delivery job are written by a single transaction (B-1).
     *
     * This is the whole reason the queue moved to Postgres. The sequence used to be
     * `save(event)` — which commits — followed by `deliveryQueue.add()` as a separate network
     * round trip to Redis. Anything that interrupted the gap left a committed event with no
     * delivery work and nothing recording that fact: a SIGTERM during a deploy, a Redis
     * failover, an OOM kill. The event showed up in the dashboard as `received` for ever and
     * the customer's destination was simply never called, silently and unrecoverably, because
     * no retry anywhere was aware there was anything to retry.
     *
     * `publishDelivery` writes the job row through the transaction's own connection, so the
     * invariant is structural rather than best-effort: **if this transaction commits, durable
     * delivery work exists for it.** There is no window to close, and therefore no outbox
     * table and sweeper needed to close one.
     *
     * It also removes the failure mode where the queue is unreachable but the database is
     * fine. The job is a row in this same database, inserted over this same connection, so no
     * separate queue process has to be reachable for the work to become durable — a worker
     * that is down picks it up when it returns.
     *
     * If the publish *does* fail, the event rolls back and the sender receives a 500. That is
     * the correct direction to fail: a provider that gets a 500 retries, while a provider that
     * gets a 200 never will. Answering 200 for an event we could not queue would silently
     * drop the webhook, which is exactly the bug being fixed.
     */
    const savedEvent = await AppDataSource.transaction(async (manager) => {
      const saved = await manager.getRepository(Event).save(event)

      await publishDelivery(getBoss(), manager, {
        eventId: saved.id,
        endpointId,
      })

      return saved
    })

    // Only after a committed insert, so a rejected sender retrying cannot inflate usage.
    await recordEventStored(userId)

    /**
     * Publishes through the Redis adapter, so it reaches dashboard clients connected to the
     * API process rather than to this one (H-12). The payload carries the redacted headers,
     * because that is what was stored.
     *
     * After the commit, not before: the live feed must not show an event that a rolled-back
     * transaction means does not exist.
     */
    emitNewEvent(token, savedEvent)

    res.status(200).json({ ok: true, eventId: savedEvent.id })

    /**
     * Deliberately not awaited: the sender already has its 200 and the warning is a
     * courtesy. `warnIfApproachingLimit` contains its own error handling, so this cannot
     * become an unhandled rejection.
     */
    void warnIfApproachingLimit(user, used + 1, limit)
  } catch (error) {
    // Message only. The error object carries the failing query and its parameters, which
    // for this handler means the captured request body (H-48).
    console.error(
      'Ingestion error:',
      error instanceof Error ? error.message : 'unknown error'
    )
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' })
    }
  }
}

router.post('/in/:token', resolveEndpoint, ingestRateLimiter, handleIngest)
router.get('/in/:token', resolveEndpoint, ingestRateLimiter, handleIngest)

export default router
