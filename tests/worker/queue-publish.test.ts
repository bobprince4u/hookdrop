import '../support/env'

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  closeDatabase,
  count,
  createScenario,
  one,
  reset,
} from '../support/database'
import {
  QUEUES,
  jobCountOn,
  onlyJobOn,
  registrationOf,
  startTestQueue,
  stopTestQueue,
} from '../support/queue'
import { AppDataSource, initDB } from '../../apps/worker/src/db'
import {
  DELIVERY_QUEUE,
  DEMO_CLEANUP_QUEUE,
  EMAIL_QUEUE,
  RETENTION_QUEUE,
  SUBSCRIPTION_EXPIRY_QUEUE,
  publishDelivery,
  publishEmail,
} from '../../apps/worker/src/queue/contract'
import type { DeliveryJob } from '../../apps/worker/src/queue/contract'

/**
 * Publishing: the transactional guarantee the migration exists to provide.
 *
 * This file is the one that would have failed under BullMQ. The old ingestion path committed
 * an event and then called `deliveryQueue.add()` over a second connection to a second
 * datastore, so a crash between the two left a committed event with no delivery work and
 * nothing recording that it had been lost (B-1). There was no way to write a test for the
 * property, because the property did not hold.
 *
 * Covers §24.1 (publishing), §24.8 (the transactional invariant that replaces an outbox),
 * §5 (payload contents), and Scenarios A and D from §25.
 */

/** A destination secret and an event body, so the payload assertions have something to find. */
const SECRET = 'whsec_publish_suite_should_never_see_this'
const BODY = '{"pan":"4242424242424242","amount":1999}'

describe('queue publishing', () => {
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

  /**
   * §24.1, and Scenario A: the worker is down — nothing in this file consumes — and the job
   * is still durable work in the database afterwards. `started_on IS NULL` is the assertion
   * that no consumer touched it, which is what "the worker was down" means from the
   * database's point of view.
   */
  it('writes one delivery job for a committed event', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })
    })

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)

    assert.equal(job.name, QUEUES.delivery)
    assert.equal(job.state, 'created')
    assert.equal(job.started_on, null)
    assert.deepEqual(job.data, {
      eventId: scenario.eventId,
      endpointId: scenario.endpointId,
    })
  })

  /**
   * The retry policy a job inherits comes from the queue registration, not from the `send`,
   * so a producer that passed retry options would be silently ignored and a contract change
   * that never reached `createQueue` would be silently absent. The job row carries the
   * resolved values, which is where both would show up.
   */
  it('gives the published job the retry policy from the contract', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })
    })

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(job.retry_limit, DELIVERY_QUEUE.retryLimit)
    assert.equal(job.policy, DELIVERY_QUEUE.policy)
  })

  /**
   * `group: { id: eventId }` is half of the Scenario E guard — the other half is
   * `groupConcurrency: 1` on the consumer. If the group id stopped being written, two jobs
   * for one event could run at once and nothing else in the system would notice, so the
   * column is asserted directly.
   */
  it('groups delivery jobs by event id', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })
    })

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(job.group_id, scenario.eventId)
  })

  /**
   * §24.8 and §11. The invariant is "if an event transaction commits, there must be durable
   * delivery work associated with it" — which is only meaningful if the converse also holds,
   * so both directions are asserted here against the same transaction shape: the event row
   * and the job row are written by one transaction, and they either both exist or neither
   * does.
   */
  it('commits the event row and the delivery job together', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    let committedEventId = ''

    await AppDataSource.transaction(async (manager) => {
      const rows: Array<{ id: string }> = await manager.query(
        `insert into events (endpoint_id, method, headers, body, status)
         values ($1, 'POST', '{}'::jsonb, $2, 'received')
         returning id`,
        [scenario.endpointId, BODY]
      )
      committedEventId = rows[0]!.id

      await publishDelivery(boss, manager, {
        eventId: committedEventId,
        endpointId: scenario.endpointId,
      })
    })

    const eventExists = await count(
      `select count(*)::text as n from events where id = $1`,
      [committedEventId]
    )
    assert.equal(eventExists, 1)

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(job.data.eventId, committedEventId)
  })

  it('leaves no delivery job when the transaction rolls back', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    const failure = new Error('rolled back on purpose')
    let rolledBackEventId = ''

    await assert.rejects(
      AppDataSource.transaction(async (manager) => {
        const rows: Array<{ id: string }> = await manager.query(
          `insert into events (endpoint_id, method, headers, body, status)
           values ($1, 'POST', '{}'::jsonb, $2, 'received')
           returning id`,
          [scenario.endpointId, BODY]
        )
        rolledBackEventId = rows[0]!.id

        await publishDelivery(boss, manager, {
          eventId: rolledBackEventId,
          endpointId: scenario.endpointId,
        })

        throw failure
      }),
      failure
    )

    /**
     * Neither half survived. The event assertion is the one that proves the job insert was
     * genuinely enrolled in the transaction rather than merely absent: if `send` had used
     * pg-boss's own pool it would have committed on its own connection and left an orphan
     * job pointing at an event that does not exist.
     */
    const eventCount = await count(
      `select count(*)::text as n from events where id = $1`,
      [rolledBackEventId]
    )
    assert.equal(eventCount, 0)
    assert.equal(await jobCountOn(QUEUES.delivery), 0)
  })

  /**
   * A job published inside an open transaction must not be visible outside it. Without this
   * the transactional claim would be half true — the row would roll back correctly but a
   * worker could still fetch and run it in the window before the commit, delivering an event
   * that was never accepted.
   */
  it('does not expose the job before the transaction commits', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })

      // Read on a different connection, from the support pool, while this one is still open.
      assert.equal(await jobCountOn(QUEUES.delivery), 0)
    })

    assert.equal(await jobCountOn(QUEUES.delivery), 1)
  })

  /**
   * §5. The payload is identifiers only, and the two things most likely to be added to it
   * "for convenience" are the ones checked for by value: the destination's signing secret
   * and the event body. A queue table with either in it would put a credential and customer
   * data somewhere with a different retention policy than the tables they belong to, and
   * §23 forbids logging a payload that could contain them.
   */
  it('publishes identifiers only', async () => {
    const scenario = await createScenario({
      destinationSecret: SECRET,
    })
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })
    })

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)

    assert.deepEqual(Object.keys(job.data).sort(), ['endpointId', 'eventId'])

    const serialised = JSON.stringify(job.data)
    assert.ok(
      !serialised.includes(SECRET),
      'the destination signing secret must never reach the queue'
    )
    assert.ok(
      !serialised.includes('4242'),
      'the event body must never reach the queue'
    )
  })

  /** `replay` is the only optional field, and it is carried for logging only. */
  it('carries the replay marker when one is given', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
        replay: true,
      })
    })

    const job = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(job.data.replay, true)
  })

  /**
   * §25 Scenario D: pg-boss is unavailable.
   *
   * "Unavailable" for a queue that lives in Redis means the work is lost or unwritable. Here
   * it means a process is not running, and the distinction is the point of the migration:
   * the job is a row in the same database as the event, written over the same connection, so
   * stopping every pg-boss instance in the system cannot lose it. The row is still `created`
   * with `started_on` null afterwards, and is still there when an instance comes back.
   */
  it('keeps committed work while no pg-boss instance is running', async () => {
    const scenario = await createScenario()
    const boss = await startTestQueue()

    await AppDataSource.transaction(async (manager) => {
      await publishDelivery(boss, manager, {
        eventId: scenario.eventId,
        endpointId: scenario.endpointId,
      })
    })

    await stopTestQueue()

    const whileDown = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(whileDown.state, 'created')
    assert.equal(whileDown.started_on, null)

    await startTestQueue()

    const afterRestart = await onlyJobOn<DeliveryJob>(QUEUES.delivery)
    assert.equal(afterRestart.id, whileDown.id)
    assert.equal(afterRestart.state, 'created')
  })

  /**
   * Email publishing has no transaction by design — the welcome sequence is sent after
   * registration has committed and a mail failure must not fail registration — so the
   * assertion is on the payload and the delay instead.
   */
  it('publishes a delayed email job', async () => {
    const boss = await startTestQueue()

    const before = Date.now()
    await publishEmail(
      boss,
      { template: 'day3-upgrade', email: 'user@example.invalid', name: 'User' },
      { startAfterSeconds: 3600 }
    )

    const job = await onlyJobOn<{ template: string; email: string }>(
      QUEUES.email
    )
    assert.equal(job.data.template, 'day3-upgrade')
    assert.equal(job.retry_limit, EMAIL_QUEUE.retryLimit)

    const delayMs = job.start_after.getTime() - before
    assert.ok(
      delayMs > 3_500_000 && delayMs < 3_700_000,
      `expected the job to start about an hour out, got ${Math.round(delayMs / 1000)}s`
    )
  })

  /**
   * The contract declares the retry semantics; `createQueue` is what puts them in the
   * database. Nothing at runtime checks that the two agree, and a queue whose retry limit
   * never arrived would look identical to a working one until a delivery needed a second
   * attempt. Read the registry back and compare it to the source.
   */
  it('registers every queue with the policy the contract declares', async () => {
    await startTestQueue()

    for (const queue of [
      DELIVERY_QUEUE,
      EMAIL_QUEUE,
      RETENTION_QUEUE,
      SUBSCRIPTION_EXPIRY_QUEUE,
      DEMO_CLEANUP_QUEUE,
    ]) {
      const registered = await registrationOf(
        queue.name as (typeof QUEUES)[keyof typeof QUEUES]
      )

      assert.ok(registered, `queue "${queue.name}" is not registered`)
      assert.equal(registered.policy, queue.policy, `${queue.name} policy`)
      assert.equal(
        registered.retry_limit,
        queue.retryLimit,
        `${queue.name} retryLimit`
      )
      assert.equal(
        registered.expire_seconds,
        queue.expireInSeconds,
        `${queue.name} expireInSeconds`
      )
    }
  })

  /**
   * The producers refuse to boot against a database where the worker has not registered the
   * queues, because a `send` to an unregistered queue throws — and for ingestion that would
   * mean rolling back an event a provider has already been told nothing about. The failure is
   * asserted here so the precondition `assertQueuesExist` protects against stays real.
   */
  it('rejects a publish to a queue that does not exist', async () => {
    const boss = await startTestQueue()

    await assert.rejects(boss.send('delivery-typo', { eventId: 'x' }, {}))

    const stray = await one<{ n: string }>(
      `select count(*)::text as n from pgboss.job where name = 'delivery-typo'`
    )
    assert.equal(Number(stray?.n ?? 0), 0)
  })
})
