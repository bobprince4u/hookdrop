import '../support/env'

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { TestContext } from 'node:test'

import axios, { AxiosError, AxiosHeaders } from 'axios'
import type {
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios'
import type { JobWithMetadata } from 'pg-boss'

import { captureConsole } from '../support/console'
import {
  closeDatabase,
  createDelivery,
  createScenario,
  db,
  deliveryRow,
  eventStatus,
  reset,
} from '../support/database'
import {
  QUEUES,
  asHandlerJob,
  onlyJobOn,
  startTestQueue,
  stopTestQueue,
} from '../support/queue'
import { AppDataSource, initDB } from '../../apps/worker/src/db'
import {
  MAX_DELIVERY_ATTEMPTS,
  publishDelivery,
} from '../../apps/worker/src/queue/contract'
import type { DeliveryJob } from '../../apps/worker/src/queue/contract'
import { processDelivery } from '../../apps/worker/src/processors/delivery.processor'

/**
 * Delivery processing: what a worker run does to delivery state, and what it refuses to do.
 *
 * Covers §24.2 (worker processing), §24.3 (retry), §24.4 (permanent failure), §24.5
 * (duplicate job), §24.6 (worker crash), the §8 delivery controls, the §9 requirement that
 * queue retry state and delivery state never contradict each other, the §23 log fields, and
 * Scenarios B, C and E from §25.
 *
 * ## Why the network boundary is stubbed
 *
 * `assertPublicUrl` blocks 127.0.0.1/8 along with every TEST-NET range, CGNAT and the
 * benchmarking range, so there is no address that both passes the real guard and is safe for
 * a test to bind a listener on — and §8 forbids weakening the guard to make it testable. So
 * the guard runs completely unmodified and the stub sits one layer lower, at `axios.request`,
 * which is a genuine seam: `sendPinned` reaches it as a member call on the imported module,
 * and `axios` is hoisted to the root `node_modules`, so the object this file patches is the
 * same object the processor calls.
 *
 * Destination URLs are public IP literals, which means the guard does its work and performs
 * no DNS lookup, so nothing here depends on a resolver. **Every test asserts the stub's call
 * count**, so a change that routed a request past the stub fails loudly instead of quietly
 * opening a socket from the test suite — and the two tests that assert a count of zero are
 * the ones whose whole subject is a request that must never be made.
 *
 * ## Why `processDelivery` is called directly
 *
 * The handler is invoked rather than published-and-awaited. Driving these through `boss.work`
 * would make every assertion race a poll interval, and the retry *scheduling* is pg-boss's
 * job, not this processor's — what the processor owns is the database state each outcome
 * produces and whether it throws, and both are observable synchronously. The job argument is
 * still a real one: `queueDelivery` publishes through the production `publishDelivery` and
 * adapts the row pg-boss wrote.
 */

/** Long enough to be unmistakable in a log, and never expected to appear in one. */
const SECRET = 'whsec_delivery_suite_signing_key_0f3a'

/** A card number, because §23's list of things that must not be logged is not hypothetical. */
const BODY = '{"pan":"4242424242424242","amount":1999}'

/** The single most valuable SSRF target in a hosted deployment. */
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'

/**
 * `AxiosResponse` requires a `config`, and nothing under test reads it — the processor looks
 * at `status`, `data` and `headers.location` only. One narrow cast here keeps every response
 * literal below free of them.
 */
const CONFIG_PLACEHOLDER = {
  headers: new AxiosHeaders(),
} as InternalAxiosRequestConfig

const httpResponse = (
  status: number,
  data = '',
  headers: Record<string, string> = {}
): AxiosResponse<string> => ({
  status,
  statusText: '',
  data,
  headers,
  config: CONFIG_PLACEHOLDER,
})

type Responder = (
  config: AxiosRequestConfig
) => AxiosResponse<string> | Promise<AxiosResponse<string>>

/**
 * Replaces the outbound HTTP call for the duration of one test.
 *
 * `t.mock` rather than the module-level `mock`, so the real `axios.request` is restored when
 * the test ends whether it passed or threw — a leaked stub would make every later test in the
 * file pass for the wrong reason.
 *
 * The cast is on the implementation only. `axios.request` is generic in its response type and
 * an implementation that commits to `AxiosResponse<string>` is not assignable to it, which is
 * a limitation of the signature rather than anything about this test.
 */
const stubHttp = (t: TestContext, respond: Responder) =>
  t.mock.method(axios, 'request', ((config: AxiosRequestConfig) =>
    Promise.resolve(respond(config))) as typeof axios.request)

const stubHttpFailure = (t: TestContext, error: unknown) =>
  t.mock.method(axios, 'request', (() =>
    Promise.reject(error)) as typeof axios.request)

/** Header values are `AxiosHeaderValue`, and the assertions compare strings. */
const headerOf = (config: AxiosRequestConfig, name: string): string =>
  String((config.headers as Record<string, unknown> | undefined)?.[name] ?? '')

/** Publishes through the production path and returns the job a handler would receive. */
const queueDelivery = async (scenario: {
  eventId: string
  endpointId: string
}): Promise<JobWithMetadata<DeliveryJob>> => {
  const boss = await startTestQueue()

  await AppDataSource.transaction(async (manager) => {
    await publishDelivery(boss, manager, {
      eventId: scenario.eventId,
      endpointId: scenario.endpointId,
    })
  })

  return asHandlerJob(await onlyJobOn<DeliveryJob>(QUEUES.delivery))
}

describe('delivery processing', () => {
  before(async () => {
    await initDB()
    await startTestQueue()
  })

  beforeEach(async () => {
    await reset()
  })

  after(async () => {
    await stopTestQueue()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    await closeDatabase()
  })

  /** §24.2. */
  it('delivers a 2xx response and records the attempt', async (t) => {
    const scenario = await createScenario()
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200, 'ok'))

    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 1)

    const delivery = await deliveryRow(
      scenario.eventId,
      scenario.destinationIds[0]!
    )
    assert.equal(delivery.status, 'delivered')
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.response_code, 200)
    assert.equal(delivery.response_body, 'ok')
    assert.ok(delivery.delivered_at, 'delivered_at should be set')
    assert.ok(delivery.last_attempted_at, 'last_attempted_at should be set')

    assert.equal(await eventStatus(scenario.eventId), 'delivered')
  })

  /**
   * §8, HMAC signing. The expected value is recomputed here from the secret and the stored
   * body rather than by calling `signDelivery`, which would be comparing the implementation
   * with itself; this is the recipe `docs/hardening.md` gives destination owners, so the test
   * fails if the documented verification stops working.
   */
  it('signs the exact bytes it forwards with the destination secret', async (t) => {
    const scenario = await createScenario({
      destinationSecret: SECRET,
      eventBody: BODY,
    })
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200))

    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 1)
    const config = sent.mock.calls[0]!.arguments[0]!

    // The bytes as received, so a receiver verifying against its own raw body matches.
    assert.ok(Buffer.isBuffer(config.data), 'the body should be sent as bytes')
    assert.ok((config.data as Buffer).equals(Buffer.from(BODY, 'utf8')))

    const timestamp = headerOf(config, 'X-Hookdrop-Timestamp')
    assert.match(timestamp, /^\d{10}$/)

    const expected =
      'v1=' +
      createHmac('sha256', SECRET)
        .update(timestamp)
        .update('.')
        .update(Buffer.from(BODY, 'utf8'))
        .digest('hex')

    assert.equal(headerOf(config, 'X-Hookdrop-Signature'), expected)
  })

  /**
   * §8, the per-request controls. Every one of these is a control a refactor could drop
   * without any test failing otherwise: `maxRedirects: 0` is what forces each hop through the
   * guard, `validateStatus: null` is what lets the processor classify a 4xx as a failure
   * rather than have axios throw (H-08), the timeout bounds a destination that never answers,
   * `maxContentLength` bounds what it can make this process hold, and the `Host` header is
   * what makes a request to a pinned address arrive at the right virtual host.
   */
  it('sends with redirects off, a bounded timeout and the Host header preserved', async (t) => {
    const scenario = await createScenario({
      destinationUrl: 'https://93.184.216.34:8443/hook?tenant=7',
    })
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200))

    await processDelivery(job)

    const config = sent.mock.calls[0]!.arguments[0]!
    assert.equal(config.method, 'POST')
    assert.equal(config.url, 'https://93.184.216.34:8443/hook?tenant=7')
    assert.equal(headerOf(config, 'Host'), '93.184.216.34:8443')
    assert.equal(config.maxRedirects, 0)
    assert.equal(config.timeout, 10_000)
    assert.equal(config.validateStatus, null)
    assert.equal(config.maxContentLength, 256 * 1024)
    assert.equal(headerOf(config, 'X-Hookdrop-Event-Id'), scenario.eventId)
    assert.equal(headerOf(config, 'X-Hookdrop-Attempt'), '1')
  })

  /**
   * §24.3. Throwing is what schedules the retry, so the throw is part of the contract and is
   * asserted, not merely tolerated.
   *
   * The second run is §24.6 in the form the processor owns: a worker killed mid-delivery
   * leaves the row non-terminal, the job comes back, and the attempt counter continues from
   * the row rather than restarting or being taken from the job.
   */
  it('leaves a 500 retrying and throws so the queue schedules another run', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(500, 'boom'))

    await assert.rejects(
      processDelivery(job),
      /Delivery incomplete for event/,
      'a non-terminal delivery must ask the queue for another run'
    )

    const first = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(first.status, 'retrying')
    assert.equal(first.attempt_count, 1)
    assert.equal(first.response_code, 500)
    assert.match(first.response_body ?? '', /^Destination responded 500: boom$/)
    assert.equal(await eventStatus(scenario.eventId), 'delivering')

    await assert.rejects(processDelivery(job))

    const second = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(second.status, 'retrying')
    assert.equal(second.attempt_count, 2)
    assert.equal(sent.mock.callCount(), 2)
  })

  /**
   * §24.4, the per-destination ceiling. `MAX_DELIVERY_ATTEMPTS` is what a customer observes,
   * and it is counted on the row — so this run is the fourth attempt, not the first.
   *
   * It does not throw. There is nothing left to retry, and asking the queue for another run
   * would produce a job that re-reads terminal rows and does no work.
   */
  it('dead-letters a destination that reaches the attempt ceiling', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!

    await createDelivery({
      eventId: scenario.eventId,
      destinationId,
      attemptCount: MAX_DELIVERY_ATTEMPTS - 1,
      status: 'retrying',
    })

    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(503, 'still down'))

    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'dead_letter')
    assert.equal(delivery.attempt_count, MAX_DELIVERY_ATTEMPTS)
    assert.equal(delivery.response_code, 503)
    assert.equal(await eventStatus(scenario.eventId), 'failed')
  })

  /**
   * §24.4, permanent failure. A 404 will be a 404 on the fourth try, so it is failed at once
   * rather than after three pointless retries — and it is failed rather than recorded as
   * delivered, which is what `validateStatus: (s) => s < 500` used to do (H-08): a destination
   * answering 401 or 404 for every event looked perfectly healthy in the dashboard.
   */
  it('fails a non-retryable 4xx immediately instead of spending retries', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(404, 'no such hook'))

    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.response_code, 404)
    assert.match(
      delivery.response_body ?? '',
      /^Destination responded 404: no such hook$/
    )
    assert.equal(await eventStatus(scenario.eventId), 'failed')
  })

  /**
   * The exception to the rule above: a handful of 4xx statuses describe a temporary
   * condition. 429 is the one that matters in practice — a rate-limited destination is asking
   * to be retried, and treating it as permanent would drop the event.
   */
  it('retries the 4xx statuses that describe a temporary condition', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    stubHttp(t, () => httpResponse(429, 'slow down'))

    await assert.rejects(processDelivery(job))

    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'retrying')
    assert.equal(delivery.response_code, 429)
  })

  /**
   * §24.5 and §25 Scenario B: the customer received the request, the worker died before the
   * job was acknowledged, and pg-boss redelivers it after `expireInSeconds`. At-least-once
   * delivery of the *job* is only safe because of this check — the row is terminal, so no
   * second POST is made and nothing is written.
   *
   * A call count of zero is the assertion. Attempt counts and statuses would also be
   * unchanged if the processor had sent the request and then written the same values back.
   */
  it('sends nothing for a destination that already reached a terminal state', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!

    await createDelivery({
      eventId: scenario.eventId,
      destinationId,
      attemptCount: 1,
      status: 'delivered',
      responseCode: 200,
      deliveredAt: new Date(),
    })

    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200, 'ok'))

    await processDelivery(job)

    assert.equal(
      sent.mock.callCount(),
      0,
      'a redelivered job must not repeat a completed delivery'
    )
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'delivered')
    assert.equal(delivery.attempt_count, 1)
    assert.equal(await eventStatus(scenario.eventId), 'delivered')
  })

  /**
   * §24.5 again, from the other side: the duplicate is the same job run twice back to back,
   * which is what a replay enqueued while the original was still queued produces. The first
   * run makes the row terminal and the second finds it that way.
   */
  it('runs the same job twice without delivering twice', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200, 'ok'))

    await processDelivery(job)
    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.status, 'delivered')
  })

  /**
   * §8, SSRF. The destination was stored before the write-time check existed, or by something
   * that bypassed it, which is why the guard runs at delivery time as well.
   *
   * Permanent, not retryable: neither a misconfiguration nor an SSRF attempt becomes
   * acceptable on the fourth try, and retrying would turn one stored URL into four outbound
   * probes of the instance metadata service.
   */
  it('refuses a blocked destination without opening a socket', async (t) => {
    const scenario = await createScenario({ destinationUrl: METADATA_URL })
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200, 'metadata'))

    await processDelivery(job)

    assert.equal(
      sent.mock.callCount(),
      0,
      'the link-local address must never be requested'
    )
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.response_code, null)
    assert.match(delivery.response_body ?? '', /reserved or private/)
    assert.equal(await eventStatus(scenario.eventId), 'failed')
  })

  /**
   * §8, redirect protection — the case a single up-front check misses. The destination is
   * public and passes the guard; its response is a 302 to the metadata service.
   *
   * Exactly one request, and it is the one to the public address. The second hop is
   * revalidated before any socket is opened, which is why `maxRedirects` is 0 and the hops are
   * walked by the processor instead of by axios.
   */
  it('re-validates every redirect hop and refuses one that leaves public space', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () =>
      httpResponse(302, '', { location: METADATA_URL })
    )

    await processDelivery(job)

    assert.equal(
      sent.mock.callCount(),
      1,
      'the redirect target must never be requested'
    )
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'failed')
    assert.match(delivery.response_body ?? '', /reserved or private/)
  })

  /**
   * §25 Scenario C: a request timed out, which is not the same as a request the destination
   * did not receive. The destination may have processed it and been slow to answer.
   *
   * So it is retried — the only safe choice, since the alternative is dropping deliveries
   * whenever a receiver is slow — and the consequence is that a destination can legitimately
   * see the same event twice. That is what makes delivery at-least-once rather than
   * exactly-once, and why `docs/hardening.md` documents the signature and event id a receiver
   * needs in order to deduplicate.
   */
  it('treats a timeout as retryable rather than as a delivery that did not happen', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttpFailure(
      t,
      new AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED')
    )

    await assert.rejects(processDelivery(job))

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'retrying')
    assert.equal(delivery.response_code, null)
    assert.match(delivery.response_body ?? '', /^ECONNABORTED: timeout of/)
    assert.equal(await eventStatus(scenario.eventId), 'delivering')
  })

  /**
   * §9: pg-boss retry state and delivery state must not contradict each other.
   *
   * The queue's `retryLimit` is a backstop, generous enough that the per-destination ceiling
   * is normally what stops delivery. If it is nevertheless reached — a long database outage
   * across many runs — the run that discovers it is the last one, and throwing would leave
   * this row claiming to be retrying for ever while nothing ever came back for it. So the
   * final run resolves the row itself and does not throw.
   *
   * `dead_letter` rather than `failed`: no destination gave a permanently fatal answer,
   * delivery ran out of attempts. `class=queue-budget-exhausted` distinguishes it in the log
   * from an ordinary exhausted delivery, because reaching it at all is abnormal.
   */
  it('resolves stranded rows on the final run instead of leaving them retrying', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)

    // The last run the queue will give this job: retries performed === retries permitted.
    const finalRun: JobWithMetadata<DeliveryJob> = {
      ...job,
      retryCount: job.retryLimit,
    }

    const sent = stubHttp(t, () => httpResponse(500, 'still down'))
    const captured = captureConsole(t)

    await processDelivery(finalRun)

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'dead_letter')
    assert.equal(delivery.attempt_count, 1)
    assert.match(
      delivery.response_body ?? '',
      /^Queue retry budget exhausted after 1 attempt\(s\): Destination responded 500/
    )
    assert.equal(await eventStatus(scenario.eventId), 'failed')
    assert.match(captured(), /class=queue-budget-exhausted/)
  })

  /**
   * The retention sweep deleted the event while its delivery job was still queued. The job
   * completes rather than failing eleven times over the next few hours for work that no longer
   * exists — and it sends nothing, because there is no body left to send.
   */
  it('discards a job whose event has been pruned', async (t) => {
    const scenario = await createScenario()
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(200, 'ok'))

    await db().query('delete from events where id = $1', [scenario.eventId])

    await processDelivery(job)

    assert.equal(sent.mock.callCount(), 0)
  })

  /**
   * Attempts belong to destinations, not to jobs.
   *
   * This is the shape of defect the queue's own counter caused: with one flaky destination and
   * one healthy one, BullMQ's per-job `attempts` was decremented by the flaky one while the
   * healthy one had also consumed it, and every retry re-attempted destinations that had
   * already finished. Two things are asserted — the healthy destination is never requested a
   * second time, and its attempt count never moves past 1 — because either one alone would
   * pass if the other regressed.
   */
  it('counts attempts per destination and skips the ones that finished', async (t) => {
    const scenario = await createScenario({ destinations: 2 })
    const healthy = scenario.destinationIds[0]!
    const flaky = scenario.destinationIds[1]!
    const job = await queueDelivery(scenario)

    let run = 1
    const sent = stubHttp(t, (config) => {
      const isHealthy = String(config.url).endsWith('/hook-0')
      if (run === 1) {
        return isHealthy ? httpResponse(200, 'ok') : httpResponse(500, 'boom')
      }
      return httpResponse(200, 'recovered')
    })

    await assert.rejects(processDelivery(job))

    assert.equal(sent.mock.callCount(), 2)
    assert.equal(
      (await deliveryRow(scenario.eventId, healthy)).status,
      'delivered'
    )
    assert.equal(
      (await deliveryRow(scenario.eventId, flaky)).status,
      'retrying'
    )
    assert.equal(await eventStatus(scenario.eventId), 'delivering')

    run = 2
    await processDelivery(job)

    assert.equal(
      sent.mock.callCount(),
      3,
      'the second run must request only the destination that had not finished'
    )
    assert.match(
      String(sent.mock.calls[2]!.arguments[0]!.url),
      /\/hook-1$/,
      'and that destination must be the flaky one'
    )

    const finished = await deliveryRow(scenario.eventId, flaky)
    assert.equal(finished.status, 'delivered')
    assert.equal(finished.attempt_count, 2)

    const untouched = await deliveryRow(scenario.eventId, healthy)
    assert.equal(untouched.attempt_count, 1)

    assert.equal(await eventStatus(scenario.eventId), 'delivered')
  })

  /**
   * §23, both directions.
   *
   * The required fields — job, delivery, event and destination ids, the attempt, the result
   * and the failure classification — have to be there, or a production failure cannot be
   * traced across retries. The signing secret, the HMAC signature it produces and the event
   * body must not be, and the signature is the one most easily leaked: it lives in the request
   * headers, and an axios error serialises its own `config` (H-48), so anything that logged an
   * error object rather than a message would publish it.
   */
  it('logs every delivery identifier and none of the secrets', async (t) => {
    const scenario = await createScenario({
      destinationSecret: SECRET,
      eventBody: BODY,
    })
    const destinationId = scenario.destinationIds[0]!
    const job = await queueDelivery(scenario)
    const sent = stubHttp(t, () => httpResponse(500, 'boom'))
    const captured = captureConsole(t)

    await assert.rejects(processDelivery(job))

    const log = captured()
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    const signature = headerOf(
      sent.mock.calls[0]!.arguments[0]!,
      'X-Hookdrop-Signature'
    )

    assert.match(log, new RegExp(`job=${job.id}\\b`))
    assert.match(log, new RegExp(`event=${scenario.eventId}\\b`))
    assert.match(log, new RegExp(`destination=${destinationId}\\b`))
    assert.match(log, new RegExp(`delivery=${delivery.id}\\b`))
    assert.match(log, new RegExp(`attempt=1/${MAX_DELIVERY_ATTEMPTS}\\b`))
    assert.match(log, /result=retrying class=retry status=500/)

    assert.ok(
      signature.startsWith('v1=') && signature.length > 60,
      'the request should have been signed, or the next assertion proves nothing'
    )
    assert.ok(
      !log.includes(SECRET),
      'the destination signing secret must not be logged'
    )
    assert.ok(!log.includes(signature), 'the HMAC signature must not be logged')
    assert.ok(
      !log.includes('4242424242424242'),
      'the event body must not be logged'
    )
  })
})
