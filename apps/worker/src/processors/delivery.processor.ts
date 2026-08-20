import type { JobWithMetadata } from 'pg-boss'
import axios, { AxiosResponse } from 'axios'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery, DeliveryStatus } from '../entities/Delivery'
import { assertPublicUrl, BlockedUrlError, SafeTarget } from '../services/url-guard'
import {
  signDelivery,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../services/signature.service'
import { DeliveryJob, MAX_DELIVERY_ATTEMPTS } from '../queue/contract'

/**
 * Attempts are counted per destination, on the delivery row — never per job.
 *
 * The number lives in `queue/contract.ts` because the queue's own retry budget has to be
 * chosen against it, and two files disagreeing about how many attempts a destination gets
 * is precisely the contradiction this migration had to remove.
 */
const MAX_ATTEMPTS = MAX_DELIVERY_ATTEMPTS

/** Redirect hops followed, each re-validated against the SSRF guard. */
const MAX_REDIRECTS = 3

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Cap on what a destination can make this worker hold in memory. Without it a hostile
 * or broken destination could stream an unbounded response into the process.
 */
const MAX_RESPONSE_BYTES = 256 * 1024

/** Only the head of the response is kept; the column is for debugging, not archival. */
const RESPONSE_BODY_STORED_CHARS = 1000

/**
 * 4xx statuses that describe a temporary condition rather than a broken request.
 * Everything else in the 4xx range means "this request will never succeed", so
 * retrying it four times only delays the dead letter.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 423, 425, 429])

/** States from which no further attempt should be made. */
const TERMINAL_STATUSES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'delivered',
  'failed',
  'dead_letter',
])

type Attempt =
  | { kind: 'delivered'; status: number; body: string }
  /** Might succeed later — consumes an attempt and asks the queue for another run. */
  | { kind: 'retry'; detail: string; status: number | null }
  /** Will never succeed — dead-lettered immediately without burning three retries. */
  | { kind: 'permanent'; detail: string; status: number | null }

/**
 * One structured line per delivery outcome.
 *
 * Fixed `key=value` fields, so every attempt on one delivery can be traced across retries
 * by job, event, destination and delivery id, and a failure can be classified without
 * reading the message. `detail` is the destination's own response body or a transport
 * error string and is truncated; request headers never appear here, so the HMAC signature,
 * the destination secret and the payload cannot reach the log (H-48). `JSON.stringify`
 * keeps a multi-line response body on one line.
 */
const formatDeliveryLog = (fields: {
  jobId: string
  eventId: string
  destinationId: string
  deliveryId: string
  attempt: number
  result: string
  classification?: string
  status?: number | null
  detail?: string
  replay?: boolean
}): string => {
  const parts = [
    `job=${fields.jobId}`,
    `event=${fields.eventId}`,
    `destination=${fields.destinationId}`,
    `delivery=${fields.deliveryId}`,
    `attempt=${fields.attempt}/${MAX_ATTEMPTS}`,
    `result=${fields.result}`,
  ]
  if (fields.classification) parts.push(`class=${fields.classification}`)
  if (fields.status !== undefined && fields.status !== null) {
    parts.push(`status=${fields.status}`)
  }
  if (fields.replay) parts.push('replay=true')
  if (fields.detail) {
    parts.push(`detail=${JSON.stringify(fields.detail.slice(0, 300))}`)
  }
  return parts.join(' ')
}

/** A destination this run left in `retrying`, kept in case this run is the last one. */
interface StrandedDelivery {
  deliveryId: string
  destinationId: string
  destinationUrl: string
  attempt: number
  detail: string
}

export const processDelivery = async (
  job: JobWithMetadata<DeliveryJob>
): Promise<void> => {
  const { eventId, endpointId, replay } = job.data
  const jobId = job.id

  /**
   * Whether this is the last run the queue will give this job.
   *
   * `DELIVERY_QUEUE.retryLimit` is a backstop, not the attempt counter — the delivery rows
   * are authoritative and `MAX_ATTEMPTS` is what a customer observes. The backstop still
   * has to be handled, because throwing on the final run would leave every row this run
   * set to `retrying` in that state permanently: nothing would ever come back for them,
   * and the dashboard would show a delivery still being attempted after the queue had
   * given up. So the final run resolves those rows itself, which is what keeps queue state
   * and delivery state from contradicting each other.
   *
   * `retryCount` is the number of retries already performed, so it equals `retryLimit` on
   * the last permitted run. Both fields are populated only when the consumer passes
   * `includeMetadata: true`, which `../queue/handlers` does.
   */
  const isFinalAttempt = job.retryCount >= job.retryLimit

  const eventRepo = AppDataSource.getRepository(Event)
  const destinationRepo = AppDataSource.getRepository(Destination)
  const deliveryRepo = AppDataSource.getRepository(Delivery)

  const event = await eventRepo.findOne({ where: { id: eventId } })

  if (!event) {
    /**
     * Completed, not failed. The event is gone — pruned by the retention sweep, or its
     * endpoint deleted — so there is nothing a retry could accomplish, and returning
     * discards the job instead of failing it eleven times first.
     */
    console.error(`Delivery job ${jobId}: event ${eventId} not found; discarding`)
    return
  }

  /**
   * `Destination.secret` is `select: false`, so a plain `find` would return it as
   * `undefined` here and every delivery would ship unsigned while still looking
   * correct (H-11). This is the one place entitled to the key, so it opts in
   * explicitly rather than relying on the column default.
   */
  const destinations = await destinationRepo
    .createQueryBuilder('destination')
    .where('destination.endpoint_id = :endpointId', { endpointId })
    .andWhere('destination.is_active = true')
    .addSelect('destination.secret')
    .getMany()

  if (destinations.length === 0) {
    console.log(
      `Delivery job ${jobId}: no active destinations for endpoint ${endpointId}`
    )
    await eventRepo.update(eventId, { status: 'delivered' })
    return
  }

  /**
   * The exact bytes forwarded, and the exact bytes signed. `Event.body` is a `text`
   * column, so this is the payload as received.
   */
  const body = Buffer.from(event.body ?? '', 'utf8')

  let anyTerminalFailure = false
  let retryReason: string | null = null
  const stranded: StrandedDelivery[] = []

  for (const destination of destinations) {
    let delivery = await deliveryRepo.findOne({
      where: { event_id: eventId, destination_id: destination.id },
    })

    /**
     * Skip anything already in a terminal state, not just `delivered`.
     *
     * The previous check looked only for `delivered`, so when a job was retried on
     * behalf of one destination, every already-failed destination was attempted again —
     * including permanent failures that could not change outcome.
     *
     * This is also the idempotency guarantee that makes at-least-once delivery of the
     * *job* safe: a job that runs twice — redelivered after a worker was killed, or
     * enqueued twice by a replay — re-reads these rows and does no work for any
     * destination that has already finished.
     */
    if (delivery && TERMINAL_STATUSES.has(delivery.status)) {
      if (delivery.status !== 'delivered') anyTerminalFailure = true
      continue
    }

    if (!delivery) {
      delivery = await deliveryRepo.save(
        deliveryRepo.create({
          event_id: eventId,
          destination_id: destination.id,
          status: 'pending',
          attempt_count: 0,
        })
      )
    }

    /**
     * Per-destination attempt count read from the row.
     *
     * The queue's own retry counter is a property of the job, which covers every
     * destination on the endpoint at once — so with two destinations, one flaky and one
     * healthy, the flaky one's retries were being counted against a number the healthy one
     * had also incremented. The row's own counter is the only per-destination truth
     * available, and it is why the database and not the queue decides when delivery stops.
     */
    const attempt = delivery.attempt_count + 1

    const outcome = await attemptDelivery({
      destination,
      body,
      eventId,
      attempt,
    })

    if (outcome.kind === 'delivered') {
      await deliveryRepo.update(delivery.id, {
        status: 'delivered',
        response_code: outcome.status,
        response_body: outcome.body.slice(0, RESPONSE_BODY_STORED_CHARS),
        attempt_count: attempt,
        last_attempted_at: new Date(),
        delivered_at: new Date(),
      })
      console.log(
        formatDeliveryLog({
          jobId,
          eventId,
          destinationId: destination.id,
          deliveryId: delivery.id,
          attempt,
          result: 'delivered',
          status: outcome.status,
          replay,
        })
      )
      continue
    }

    const exhausted = outcome.kind === 'permanent' || attempt >= MAX_ATTEMPTS
    const status: DeliveryStatus = exhausted
      ? outcome.kind === 'permanent'
        ? 'failed'
        : 'dead_letter'
      : 'retrying'

    await deliveryRepo.update(delivery.id, {
      status,
      response_code: outcome.status,
      response_body: outcome.detail.slice(0, RESPONSE_BODY_STORED_CHARS),
      attempt_count: attempt,
      last_attempted_at: new Date(),
    })

    if (!exhausted) {
      retryReason = outcome.detail
      stranded.push({
        deliveryId: delivery.id,
        destinationId: destination.id,
        destinationUrl: destination.url,
        attempt,
        detail: outcome.detail,
      })
      console.warn(
        formatDeliveryLog({
          jobId,
          eventId,
          destinationId: destination.id,
          deliveryId: delivery.id,
          attempt,
          result: 'retrying',
          classification: outcome.kind,
          status: outcome.status,
          detail: outcome.detail,
          replay,
        })
      )
      continue
    }

    anyTerminalFailure = true
    console.error(
      formatDeliveryLog({
        jobId,
        eventId,
        destinationId: destination.id,
        deliveryId: delivery.id,
        attempt,
        result: status,
        classification: outcome.kind,
        status: outcome.status,
        detail: outcome.detail,
        replay,
      })
    )

    await notifyFailure(eventId, destination.url)
  }

  /**
   * The queue's backstop has been reached while rows are still non-terminal.
   *
   * There will be no further run, so they are resolved here instead of being left
   * claiming to be retrying — the one case where the queue's retry state has to be
   * written back into delivery state. `dead_letter` rather than `failed`: no destination
   * gave a permanently-fatal answer, delivery ran out of attempts, which is the same
   * distinction the per-destination ceiling already draws.
   *
   * Reaching this at all means something unusual consumed the backstop — a database
   * outage across many runs, or an endpoint with far more destinations than the expiry
   * window allows — so it is logged with its own classification rather than looking like
   * an ordinary exhausted delivery.
   */
  if (retryReason !== null && isFinalAttempt) {
    for (const entry of stranded) {
      await deliveryRepo.update(entry.deliveryId, {
        status: 'dead_letter',
        response_body: `Queue retry budget exhausted after ${entry.attempt} attempt(s): ${entry.detail}`.slice(
          0,
          RESPONSE_BODY_STORED_CHARS
        ),
      })
      anyTerminalFailure = true
      console.error(
        formatDeliveryLog({
          jobId,
          eventId,
          destinationId: entry.destinationId,
          deliveryId: entry.deliveryId,
          attempt: entry.attempt,
          result: 'dead_letter',
          classification: 'queue-budget-exhausted',
          detail: entry.detail,
          replay,
        })
      )
      await notifyFailure(eventId, entry.destinationUrl)
    }
    retryReason = null
  }

  /**
   * Event status is decided once, after every destination has been handled.
   *
   * Previously the loop ended with an unconditional `status: 'delivered'` update. The
   * dead-letter branch did not re-throw, so control reached that line and overwrote the
   * `failed` status it had just written — a permanently undeliverable event reported
   * itself as delivered in the dashboard.
   */
  if (anyTerminalFailure) {
    await eventRepo.update(eventId, { status: 'failed' })
  } else if (retryReason === null) {
    await eventRepo.update(eventId, { status: 'delivered' })
  } else {
    await eventRepo.update(eventId, { status: 'delivering' })
  }

  /**
   * Throwing is what makes the queue schedule the retry, and it has to happen after the
   * database writes above so the recorded state matches what was attempted.
   *
   * A fresh `Error` carrying a curated message, never the underlying transport error.
   * pg-boss persists whatever is thrown into the job's `output` column — a durable row,
   * unlike BullMQ's in-memory failure — and an axios error serialises its own `config`,
   * which carries the request headers and therefore the HMAC signature (H-48).
   * `classifyTransportError` has already reduced those to a short detail string before
   * they reach here, and `queue/handlers.ts` sanitises anything unexpected.
   */
  if (retryReason !== null) {
    throw new Error(`Delivery incomplete for event ${eventId}: ${retryReason}`)
  }
}

interface AttemptArgs {
  destination: Destination
  body: Buffer
  eventId: string
  attempt: number
}

/**
 * One delivery attempt, including redirect handling.
 *
 * Every hop is validated and pinned separately: a destination that passes the guard and
 * then 302s to `http://169.254.169.254/` is exactly the case a single up-front check
 * misses, and it is why `maxRedirects` is 0 and the hops are walked here instead.
 */
const attemptDelivery = async ({
  destination,
  body,
  eventId,
  attempt,
}: AttemptArgs): Promise<Attempt> => {
  const signature = destination.secret
    ? signDelivery(destination.secret, body)
    : null

  const baseHeaders: Record<string, string> = {
    // Content type is left as-is rather than derived from the stored inbound headers:
    // changing what receivers are sent is outside the scope of these findings.
    'Content-Type': 'application/json',
    'User-Agent': 'Hookdrop/1.0',
    'X-Hookdrop-Event-Id': eventId,
    'X-Hookdrop-Attempt': String(attempt),
  }

  if (signature) {
    baseHeaders[TIMESTAMP_HEADER] = signature.timestamp
    baseHeaders[SIGNATURE_HEADER] = signature.signature
  }

  let nextUrl = destination.url

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let target: SafeTarget
    try {
      target = await assertPublicUrl(nextUrl)
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        /**
         * Permanent, deliberately. A blocked destination is either a misconfiguration
         * or an SSRF attempt, and neither becomes acceptable on the fourth try — while
         * retrying would turn one stored URL into four outbound probes of internal
         * space.
         */
        return { kind: 'permanent', detail: error.message, status: null }
      }
      throw error
    }

    let response: AxiosResponse<string>
    try {
      response = await sendPinned(target, body, baseHeaders)
    } catch (error) {
      return classifyTransportError(error)
    }

    const { status } = response

    if (status >= 200 && status < 300) {
      return {
        kind: 'delivered',
        status,
        body: typeof response.data === 'string' ? response.data : '',
      }
    }

    if (status >= 300 && status < 400) {
      const location = response.headers?.location
      if (typeof location !== 'string' || location.length === 0) {
        return {
          kind: 'permanent',
          detail: `Redirect ${status} without a Location header`,
          status,
        }
      }
      if (hop === MAX_REDIRECTS) {
        return {
          kind: 'permanent',
          detail: `Exceeded ${MAX_REDIRECTS} redirects`,
          status,
        }
      }
      // Resolved against the URL actually requested, so relative redirects work.
      nextUrl = new URL(location, target.url).toString()
      continue
    }

    /**
     * Anything that is not 2xx is a failure.
     *
     * `validateStatus: (status) => status < 500` previously recorded every 4xx as
     * `delivered`, so a destination answering 401 or 404 for every event looked
     * perfectly healthy in the dashboard (H-08).
     */
    const retryable = status >= 500 || RETRYABLE_CLIENT_STATUSES.has(status)
    const detail = `Destination responded ${status}${
      typeof response.data === 'string' && response.data.length > 0
        ? `: ${response.data.slice(0, 200)}`
        : ''
    }`

    return retryable
      ? { kind: 'retry', detail, status }
      : { kind: 'permanent', detail, status }
  }

  return {
    kind: 'permanent',
    detail: `Exceeded ${MAX_REDIRECTS} redirects`,
    status: null,
  }
}

/**
 * Sends the request to the address the guard resolved, never to the hostname.
 *
 * The URL handed to axios contains the pinned IP, and the hostname survives only in the
 * `Host` header and (for TLS) in SNI. That ordering is deliberate: if the hostname were
 * passed to the HTTP client, the client would resolve it a second time, and the DNS
 * answer that satisfied the guard would not necessarily be the one connected to. There
 * is no second lookup here to poison, so DNS rebinding has nothing to rebind — and this
 * cannot silently fail open the way a custom `lookup` hook would if it were ignored.
 *
 * TLS certificate validation is unaffected: `servername` makes Node check the
 * certificate against the original hostname rather than against the IP.
 */
const sendPinned = (
  target: SafeTarget,
  body: Buffer,
  headers: Record<string, string>
): Promise<AxiosResponse<string>> => {
  const hostForUrl = target.family === 6 ? `[${target.address}]` : target.address
  const portPart = target.url.port ? `:${target.url.port}` : ''
  const pinnedUrl = `${target.url.protocol}//${hostForUrl}${portPart}${target.url.pathname}${target.url.search}`

  const isTls = target.url.protocol === 'https:'

  const agent = isTls
    ? new https.Agent({
        keepAlive: false,
        // SNI must not be an IP literal; a literal destination simply gets no SNI.
        ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
      })
    : new http.Agent({ keepAlive: false })

  return axios.request<string>({
    method: 'POST',
    url: pinnedUrl,
    data: body,
    headers: {
      ...headers,
      // Includes the port and IPv6 brackets exactly as a normal client would send them.
      Host: target.url.host,
    },
    timeout: REQUEST_TIMEOUT_MS,
    // Redirects are walked by the caller so each hop is re-validated.
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    maxBodyLength: MAX_RESPONSE_BYTES,
    responseType: 'text',
    // Keep the body a string; the stored column is text and JSON parsing can throw.
    transitional: { forcedJSONParsing: false, silentJSONParsing: true, clarifyTimeoutError: true },
    // Status is classified by the caller, so axios must not throw on any of them.
    validateStatus: null,
    httpAgent: agent,
    httpsAgent: agent,
  })
}

/**
 * Transport-level failures. These are retryable by default: a refused connection, a
 * timeout or a reset is usually the destination being briefly unavailable, which is the
 * case retries exist for.
 */
const classifyTransportError = (error: unknown): Attempt => {
  if (!axios.isAxiosError(error)) {
    return {
      kind: 'retry',
      detail: error instanceof Error ? error.message : 'Unknown transport error',
      status: null,
    }
  }

  if (error.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
    // A destination that answers with megabytes will do so every time.
    return {
      kind: 'permanent',
      detail: `Response exceeded ${MAX_RESPONSE_BYTES} bytes`,
      status: error.response?.status ?? null,
    }
  }

  /**
   * A certificate that does not validate is a configuration problem at the destination,
   * not a transient one. It is reported rather than retried, and never bypassed.
   */
  const permanentCodes = new Set([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ])

  if (error.code && permanentCodes.has(error.code)) {
    return {
      kind: 'permanent',
      detail: `TLS verification failed: ${error.code}`,
      status: null,
    }
  }

  return {
    kind: 'retry',
    detail: `${error.code ?? 'transport error'}: ${error.message}`,
    status: error.response?.status ?? null,
  }
}

/**
 * Failure notification. Isolated so a Resend outage cannot fail the job — the delivery
 * state is already recorded by the time this runs.
 *
 * The three columns the email template needs are selected by name and nothing is
 * hydrated into an entity. The previous `relations: ['endpoint', 'endpoint.user']` loaded
 * whole rows, and `User.password_hash` has no `select: false`, so every dead-lettered
 * delivery pulled a bcrypt hash into worker memory to render an email that uses the
 * address and the display name (B-3). It also read the plan and payment-provider columns
 * for no reason. Nothing about the notification needed any of it.
 */
const notifyFailure = async (
  eventId: string,
  destinationUrl: string
): Promise<void> => {
  try {
    const { sendDeliveryFailureEmail } = await import('../services/email.service')

    const recipient = await AppDataSource.getRepository(Event)
      .createQueryBuilder('event')
      .innerJoin('event.endpoint', 'endpoint')
      .innerJoin('endpoint.user', 'user')
      .select('user.email', 'email')
      .addSelect('user.name', 'name')
      .addSelect('endpoint.name', 'endpointName')
      .where('event.id = :eventId', { eventId })
      .getRawOne<{ email: string; name: string; endpointName: string }>()

    if (recipient) {
      await sendDeliveryFailureEmail(
        recipient.email,
        recipient.name,
        recipient.endpointName,
        eventId,
        destinationUrl
      )
    }
  } catch (emailError) {
    /**
     * Message only. A Resend transport error serialises the request that produced it,
     * and that request carries `Authorization: Bearer <RESEND_API_KEY>` (H-48).
     */
    console.error(
      'Failed to send failure email:',
      emailError instanceof Error ? emailError.message : 'unknown error'
    )
  }
}
