/**
 * `apps/api` augments Express's `Request` with `validatedQuery` in an ambient declaration that
 * nothing imports — the API's own `tsconfig` picks it up through `include: ["src/**\/*"]`.
 * This project's `include` is `tests/**\/*`, and app sources arrive only through the import
 * graph, so the augmentation has to be named. Without it `middleware/validate.ts` fails to
 * compile here while compiling perfectly well in its own workspace.
 *
 * A type-only import rather than a `/// <reference path>`: the declaration file is a module —
 * it imports `Request` and re-exports the type — so importing it puts it in the program and its
 * `declare global` block applies, while the import itself is erased rather than becoming a
 * `require` of a file with no implementation. `@typescript-eslint/triple-slash-reference` asks
 * for this form, and it is load-bearing either way: delete the line and the three
 * `req.validatedQuery` uses in `middleware/validate.ts` stop compiling.
 */
import type {} from '../../apps/api/src/types/express'

import '../support/env'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { TestContext } from 'node:test'

import axios, { AxiosHeaders } from 'axios'
import type {
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios'

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
  jobCountOn,
  jobsOn,
  startTestQueue,
  stopTestQueue,
} from '../support/queue'
import type { DeliveryJob } from '../../apps/worker/src/queue/contract'
import { processDelivery } from '../../apps/worker/src/processors/delivery.processor'
import {
  AppDataSource as WorkerDataSource,
  initDB as initWorkerDB,
} from '../../apps/worker/src/db'
import {
  AppDataSource as ApiDataSource,
  initDB as initApiDB,
} from '../../apps/api/src/db'
import {
  closeQueue as closeApiQueue,
  startQueue as startApiQueue,
} from '../../apps/api/src/queue'
import { replayEvent } from '../../apps/api/src/controllers/events.controller'

/**
 * Replay: §24.7 and the §12 requirements for it.
 *
 * §12 asks for five things — reset delivery state, clear stale attempt results, create
 * durable work, remain recoverable, and avoid double *delivery* — and, explicitly, that
 * replay use the same infrastructure as ingestion rather than a second queueing
 * implementation of its own. The last one is not a state assertion, so it is tested by
 * running the API's replay and then feeding the job it produced to the *worker's* processor,
 * unmodified. If the two ever stopped agreeing about the queue name, the payload shape or
 * the reset the processor needs in order to act, these tests stop passing.
 *
 * That is why this file loads both services. Two TypeORM data sources exist in the process,
 * one per service, each with its own small pool and its own copy of `typeorm` — which is the
 * arrangement production has anyway, and neither is handed an entity belonging to the other.
 * pg-boss is started twice for the same reason: the worker's instance owns the schema and
 * registers the queues, the API's is publish-only and refuses to create either, so starting
 * the worker's first is not test setup convenience but the boot order production requires.
 *
 * The network boundary is stubbed at `axios.request`, for the reason set out at length in
 * `tests/worker/delivery-processing.test.ts`: the SSRF guard correctly refuses every address
 * a test could bind, so the guard runs unmodified and the stub sits below it.
 */

/** `AxiosResponse` requires a `config`; nothing here reads it. */
const CONFIG_PLACEHOLDER = {
  headers: new AxiosHeaders(),
} as InternalAxiosRequestConfig

const httpResponse = (status: number, data = ''): AxiosResponse<string> => ({
  status,
  statusText: '',
  data,
  headers: {},
  config: CONFIG_PLACEHOLDER,
})

const stubHttp = (t: TestContext, status: number, body = 'ok') =>
  t.mock.method(axios, 'request', ((_config: AxiosRequestConfig) =>
    Promise.resolve(httpResponse(status, body))) as typeof axios.request)

/**
 * The handler's request and response, reduced to what it touches.
 *
 * `replayEvent` reads `req.params.id`, `req.params.eId` and `req.user.id`, and answers
 * through `res.status().json()` or `res.json()` — nothing else. So the doubles carry exactly
 * those, and the two casts are the price of not standing up an HTTP server to observe a
 * transaction boundary.
 *
 * The types come from `Parameters<typeof replayEvent>` rather than from `express` and
 * `AuthRequest`: `express` is installed in `apps/api/node_modules` rather than hoisted, so a
 * direct import would not resolve from here, and deriving them from the handler means the
 * doubles are checked against the signature they are actually passed to.
 */
type ReplayRequest = Parameters<typeof replayEvent>[0]
type ReplayResponse = Parameters<typeof replayEvent>[1]

interface ReplayResult {
  status: number
  body: { ok?: boolean; jobId?: string; error?: string }
}

const callReplay = async (args: {
  userId: string
  endpointId: string
  eventId: string
}): Promise<ReplayResult> => {
  /** 200 by default: the success path answers with `res.json` and never sets a status. */
  const result: ReplayResult = { status: 200, body: {} }

  const res = {
    status(code: number) {
      result.status = code
      return this
    },
    json(body: ReplayResult['body']) {
      result.body = body
      return this
    },
  }

  const req = {
    params: { id: args.endpointId, eId: args.eventId },
    user: { id: args.userId, email: 'replay@example.invalid', plan: 'free' },
  }

  await replayEvent(
    req as unknown as ReplayRequest,
    res as unknown as ReplayResponse
  )

  return result
}

/** A delivery that already succeeded — the state a replay has to be able to undo. */
const seedSucceededDelivery = async (
  eventId: string,
  destinationId: string
): Promise<void> => {
  await createDelivery({
    eventId,
    destinationId,
    status: 'delivered',
    attemptCount: 3,
    responseCode: 200,
    responseBody: 'previous body',
    lastAttemptedAt: new Date('2026-08-01T10:00:00Z'),
    deliveredAt: new Date('2026-08-01T10:00:00Z'),
  })
  await db().query(`update events set status = 'delivered' where id = $1`, [
    eventId,
  ])
}

const deliveryJobs = async () => jobsOn<DeliveryJob>(QUEUES.delivery)

describe('replay', () => {
  before(async () => {
    // The worker's instance installs the pg-boss schema and registers the queues; the API's
    // is publish-only and fails to start if either is missing. Production boots in this order
    // for the same reason.
    await startTestQueue()
    await initWorkerDB()
    await initApiDB()
    await startApiQueue()
  })

  beforeEach(async () => {
    await reset()
  })

  after(async () => {
    await closeApiQueue()
    await stopTestQueue()
    if (ApiDataSource.isInitialized) await ApiDataSource.destroy()
    if (WorkerDataSource.isInitialized) await WorkerDataSource.destroy()
    await closeDatabase()
  })

  /**
   * §12, the reset. H-08: without it the processor's idempotency check finds a terminal row
   * and the replay silently does nothing — the button returned 200 and no request was made.
   *
   * B-5 is the other half. `response_code` and `response_body` were left behind, so a row
   * sitting in `pending` still carried the previous attempt's 200 and its body: the dashboard
   * showed a delivery that had not happened yet alongside the result of one that had, and if
   * the replay never completed, that stale pair was the only thing ever shown for it. Attempt
   * metadata and attempt results have to be cleared together or the row describes two
   * different attempts at once.
   */
  it('resets every delivery row and clears the previous attempt result', async () => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    await seedSucceededDelivery(scenario.eventId, destinationId)

    const result = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })

    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.ok(result.body.jobId, 'the response should carry the new job id')

    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'pending')
    assert.equal(delivery.attempt_count, 0)
    assert.equal(delivery.delivered_at, null)
    assert.equal(delivery.response_code, null)
    assert.equal(delivery.response_body, null)

    assert.equal(await eventStatus(scenario.eventId), 'received')
  })

  /**
   * §12, durable work — and that it is the *same* work ingestion creates.
   *
   * The queue name, the payload shape and the group key are asserted against the contract
   * rather than against a literal, and the retry policy is read off the job row: it was not
   * set by this publish at all, it came from the queue the worker registered. That is what
   * "same infrastructure" means concretely — a replay that had grown its own queue would show
   * up here as a different name or an unregistered retry limit.
   *
   * `replay: true` is carried for logging only and must not change any delivery control.
   */
  it('publishes the replay through the queue ingestion already uses', async () => {
    const scenario = await createScenario()
    await seedSucceededDelivery(scenario.eventId, scenario.destinationIds[0]!)

    const result = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })

    const jobs = await deliveryJobs()
    assert.equal(jobs.length, 1)

    const job = jobs[0]!
    assert.equal(job.id, result.body.jobId)
    assert.equal(job.name, QUEUES.delivery)
    assert.deepEqual(job.data, {
      eventId: scenario.eventId,
      endpointId: scenario.endpointId,
      replay: true,
    })

    // Bounds the fan-out: with `groupConcurrency: 1` on the consumer, no two jobs for one
    // event run at the same time anywhere in the cluster.
    assert.equal(job.group_id, scenario.eventId)

    // Not passed by the publish — inherited from the registered queue.
    assert.equal(job.retry_limit, 10)
    assert.equal(job.policy, 'standard')
    assert.equal(job.state, 'created')
  })

  /**
   * §12, recoverable — the same invariant as B-1, from the replay side.
   *
   * The reset and the publish are one transaction. If they were not, a crash between them
   * would leave every delivery row for the event reset to `pending` with nothing queued to
   * act on them: strictly worse than not replaying at all, because it also destroys the
   * record of the delivery that did succeed.
   *
   * Taking the API's pg-boss instance away is what makes the publish fail, and it fails in
   * the right place — `getBoss()` is called inside the transaction, after the reset. So this
   * observes the rollback rather than a validation that happened earlier.
   */
  it('rolls the reset back when the delivery job cannot be published', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    await seedSucceededDelivery(scenario.eventId, destinationId)

    await closeApiQueue()
    t.after(async () => {
      await startApiQueue()
    })

    // The controller reports the failure and answers 500; asserted below, and mocked so the
    // deliberate error does not read as a broken test in the output.
    const logged = t.mock.method(console, 'error', () => undefined)

    const result = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })

    assert.equal(result.status, 500)
    assert.equal(logged.mock.callCount(), 1, 'the failure must be reported')

    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(
      delivery.status,
      'delivered',
      'the reset must not survive a failed publish'
    )
    assert.equal(delivery.attempt_count, 3)
    assert.equal(delivery.response_code, 200)
    assert.equal(delivery.response_body, 'previous body')
    assert.ok(delivery.delivered_at)

    assert.equal(await eventStatus(scenario.eventId), 'delivered')
    assert.equal(await jobCountOn(QUEUES.delivery), 0)
  })

  /**
   * The end-to-end point of a replay, and the only test that proves the reset is *sufficient*
   * rather than merely present: the API resets and publishes, and the worker's processor —
   * imported unmodified, with the job row the API actually wrote — delivers again.
   *
   * The attempt count restarts at 1. A replay is a new attempt series, not a continuation of
   * the one that already finished, so the customer's four attempts are not already spent.
   */
  it('makes a delivered event deliverable again', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    await seedSucceededDelivery(scenario.eventId, destinationId)

    await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })

    const sent = stubHttp(t, 200, 'replayed')
    const jobs = await deliveryJobs()
    assert.equal(jobs.length, 1)

    await processDelivery(asHandlerJob(jobs[0]!))

    assert.equal(sent.mock.callCount(), 1)
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'delivered')
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.response_code, 200)
    assert.equal(delivery.response_body, 'replayed')
    assert.equal(await eventStatus(scenario.eventId), 'delivered')
  })

  /**
   * §12, no double delivery.
   *
   * Two replays in quick succession produce two jobs, deliberately. Rejecting the second
   * would mean guessing whether the first is still in flight; letting an idempotent processor
   * absorb it does not. What must not happen is two requests reaching the destination, and
   * that holds because the first job makes the rows terminal and the second finds them that
   * way — the same check that protects against a redelivered job after a worker crash.
   *
   * The jobs cannot in fact run concurrently: both carry `group: { id: eventId }` and the
   * consumer runs one job per group cluster-wide. Running them in sequence here is the
   * ordering pg-boss enforces, not an assumption about scheduling.
   */
  it('absorbs a second replay without delivering twice', async (t) => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    await seedSucceededDelivery(scenario.eventId, destinationId)

    const first = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })
    const second = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: scenario.eventId,
    })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.notEqual(first.body.jobId, second.body.jobId)

    const jobs = await deliveryJobs()
    assert.equal(jobs.length, 2)
    assert.deepEqual(
      jobs.map((job) => job.group_id),
      [scenario.eventId, scenario.eventId]
    )

    const sent = stubHttp(t, 200, 'replayed')

    await processDelivery(asHandlerJob(jobs[0]!))
    await processDelivery(asHandlerJob(jobs[1]!))

    assert.equal(
      sent.mock.callCount(),
      1,
      'the second job must find the delivery already terminal'
    )
    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.attempt_count, 1)
    assert.equal(delivery.status, 'delivered')
  })

  /**
   * Ownership. The endpoint is loaded by `(id, user_id)`, so another tenant's endpoint is
   * indistinguishable from one that does not exist — and, more to the point here, a replay is
   * a way to make this system send a request, so the check has to hold before anything is
   * reset or queued and not only before the response is written.
   */
  it('refuses to replay an event belonging to another account', async () => {
    const owner = await createScenario()
    const stranger = await createScenario()
    const destinationId = owner.destinationIds[0]!
    await seedSucceededDelivery(owner.eventId, destinationId)

    const result = await callReplay({
      userId: stranger.userId,
      endpointId: owner.endpointId,
      eventId: owner.eventId,
    })

    assert.equal(result.status, 404)
    assert.equal(result.body.error, 'Endpoint not found')

    const delivery = await deliveryRow(owner.eventId, destinationId)
    assert.equal(delivery.status, 'delivered')
    assert.equal(delivery.attempt_count, 3)
    assert.equal(await jobCountOn(QUEUES.delivery), 0)
  })

  /**
   * An event id that belongs to the caller's own endpoint but does not exist. Nothing is
   * reset and nothing is queued — the `where` on the reset is `event_id`, so a replay allowed
   * to proceed past a missing event would either do nothing or, with a wider predicate, reset
   * rows it was never asked about.
   */
  it('refuses to replay an event that does not exist', async () => {
    const scenario = await createScenario()
    const destinationId = scenario.destinationIds[0]!
    await seedSucceededDelivery(scenario.eventId, destinationId)

    const result = await callReplay({
      userId: scenario.userId,
      endpointId: scenario.endpointId,
      eventId: randomUUID(),
    })

    assert.equal(result.status, 404)
    assert.equal(result.body.error, 'Event not found')

    const delivery = await deliveryRow(scenario.eventId, destinationId)
    assert.equal(delivery.status, 'delivered')
    assert.equal(await jobCountOn(QUEUES.delivery), 0)
  })
})
