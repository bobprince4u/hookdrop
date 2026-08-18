import { Router, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { deliveryQueue } from '../queue'
import { emitNewEvent } from '../socket'
import { ingestRateLimiter } from '../middleware/rateLimiter'
import { redactSensitiveHeaders } from '../services/headers.util'
import { resolveEffectivePlan } from '../services/plan.service'
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
 * Six findings converged on this one handler, and they are listed here because several of
 * them were invisible while the others stood:
 *
 * - **H-26 / H-36.** The plan limits were written out twice inside this file: a module-level
 *   `PLAN_LIMITS` keyed `{ events_per_month }`, and a second inline literal forty lines
 *   further down keyed as a bare number. The inline copy had already drifted in shape, and
 *   the line that used it had been commented out — leaving `limit` bound to the *other*
 *   copy by coincidence of scope. Both are gone; `services/plan.service.ts` is the single
 *   source.
 * - **H-29.** Entitlement was read straight off `user.plan` with no reference to
 *   `plan_expires_at`, so a lapsed subscription kept its paid quota until the worker's
 *   nightly downgrade happened to run. `resolveEffectivePlan` is now consulted at the edge.
 * - **H-21.** The month boundary was local time, and the count was a fresh `COUNT(*)` over
 *   every event in the month on every request.
 * - **H-47.** The 80% warning used exact equality against that count, so it was skipped
 *   entirely by any burst that stepped over the value, and re-sent when deletions dragged
 *   the count back down.
 * - **H-17.** `req.headers` was stored verbatim, persisting whatever credentials the sender
 *   put in `Authorization`, `Cookie`, or a signature header.
 */

/**
 * Loaded per request, and deliberately narrow.
 *
 * `relations: ['user']` selected every user column, `password_hash` included, on every
 * inbound webhook. Nothing here needs it, and a bcrypt digest that never enters process
 * memory cannot be leaked by a log line or a crash dump.
 */
const findActiveEndpoint = async (token: string) =>
  AppDataSource.getRepository(Endpoint).findOne({
    where: { public_token: token, is_active: true },
    relations: { user: true },
    select: {
      id: true,
      user_id: true,
      user: {
        id: true,
        email: true,
        name: true,
        plan: true,
        plan_expires_at: true,
      },
    },
  })

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
    const endpoint = await findActiveEndpoint(token)

    if (!endpoint || !endpoint.user) {
      // Same answer for a bad token, a disabled endpoint, and a deleted owner.
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const user = endpoint.user

    /**
     * Effective plan, not the stored column (H-29). An expired paid plan resolves to free
     * here, so the quota it is checked against is the one the account is actually entitled
     * to at this instant.
     */
    const plan = resolveEffectivePlan(user)
    const limit = plan.events
    const used = await readMonthlyUsage(endpoint.user_id)

    if (used >= limit) {
      /**
       * The plan tier and the usage figures are deliberately *not* in this response. The
       * ingest URL's only credential is the token in it, so anyone who has ever seen a
       * capture URL — every provider it was pasted into, every log that recorded it — could
       * read the account's subscription tier and traffic volume out of a 429. The details
       * that are actually useful for debugging are logged server-side instead.
       */
      console.warn(
        `Ingest rejected for user ${endpoint.user_id}: ${used}/${limit} events used on the ${plan.id} plan`
      )
      res.status(429).json({ error: 'Monthly event limit reached' })
      return
    }

    const eventRepo = AppDataSource.getRepository(Event)

    const event = eventRepo.create({
      endpoint_id: endpoint.id,
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

    const savedEvent = await eventRepo.save(event)

    // Only after a committed insert, so a rejected sender retrying cannot inflate usage.
    await recordEventStored(endpoint.user_id)

    /**
     * Publishes through the Redis adapter, so it reaches dashboard clients connected to the
     * API process rather than to this one (H-12). The payload carries the redacted headers,
     * because that is what was stored.
     */
    emitNewEvent(token, savedEvent)

    await deliveryQueue.add(
      'deliver',
      { eventId: savedEvent.id, endpointId: endpoint.id },
      {
        attempts: 4,
        backoff: { type: 'exponential', delay: 5000 },
      }
    )

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

router.post('/in/:token', ingestRateLimiter, handleIngest)
router.get('/in/:token', ingestRateLimiter, handleIngest)

export default router
