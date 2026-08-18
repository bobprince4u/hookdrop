import { Job } from 'bullmq'
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

interface DeliveryJobData {
  eventId: string
  endpointId: string
}

/** Attempts are counted per destination, on the delivery row, not per BullMQ job. */
const MAX_ATTEMPTS = 4

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
  /** Might succeed later — consumes an attempt and re-throws so BullMQ retries. */
  | { kind: 'retry'; detail: string; status: number | null }
  /** Will never succeed — dead-lettered immediately without burning three retries. */
  | { kind: 'permanent'; detail: string; status: number | null }

export const processDelivery = async (
  job: Job<DeliveryJobData>
): Promise<void> => {
  const { eventId, endpointId } = job.data

  const eventRepo = AppDataSource.getRepository(Event)
  const destinationRepo = AppDataSource.getRepository(Destination)
  const deliveryRepo = AppDataSource.getRepository(Delivery)

  const event = await eventRepo.findOne({ where: { id: eventId } })

  if (!event) {
    console.error(`Event ${eventId} not found`)
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
    console.log(`No destinations for endpoint ${endpointId}`)
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
     * `job.attemptsMade` is a property of the job, which covers every destination on
     * the endpoint at once — so with two destinations, one flaky and one healthy, the
     * flaky one's retries were being counted against a number the healthy one had also
     * incremented. The row's own counter is the only per-destination truth available.
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
        `Delivered event ${eventId} to destination ${destination.id} — ${outcome.status}`
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
      console.warn(
        `Event ${eventId} → destination ${destination.id} attempt ${attempt} failed (${outcome.detail}); will retry`
      )
      continue
    }

    anyTerminalFailure = true
    console.error(
      `Event ${eventId} → destination ${destination.id} ${status} after ${attempt} attempt(s): ${outcome.detail}`
    )

    await notifyFailure(eventId, destination.url)
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
   * Re-throwing is what makes BullMQ schedule the retry, and it has to happen after the
   * database writes above so the recorded state matches what was attempted.
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
 */
const notifyFailure = async (
  eventId: string,
  destinationUrl: string
): Promise<void> => {
  try {
    const { sendDeliveryFailureEmail } = await import('../services/email.service')
    const fullEvent = await AppDataSource.getRepository(Event).findOne({
      where: { id: eventId },
      relations: ['endpoint', 'endpoint.user'],
    })
    if (fullEvent?.endpoint?.user) {
      await sendDeliveryFailureEmail(
        fullEvent.endpoint.user.email,
        fullEvent.endpoint.user.name,
        fullEvent.endpoint.name,
        eventId,
        destinationUrl
      )
    }
  } catch (emailError) {
    console.error('Failed to send failure email:', emailError)
  }
}
