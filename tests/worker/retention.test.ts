import '../support/env'

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import { captureConsole } from '../support/console'
import {
  closeDatabase,
  createDelivery,
  createDestination,
  createEndpoint,
  createEvent,
  createUser,
  db,
  deliveriesFor,
  holdEventLock,
  reset,
  resetSchedules,
} from '../support/database'
import {
  QUEUES,
  scheduleOf,
  startTestQueue,
  stopTestQueue,
} from '../support/queue'
import { AppDataSource, initDB } from '../../apps/worker/src/db'
import { env } from '../../apps/worker/src/config/env'
import { PLANS } from '../../apps/worker/src/services/plan.service'
import {
  RETENTION_CRON,
  enforceRetention,
} from '../../apps/worker/src/schedulers/retention.scheduler'
import {
  DEMO_CLEANUP_CRON,
  SUBSCRIPTION_EXPIRY_CRON,
} from '../../apps/worker/src/schedulers/subscription.scheduler'
import { registerSchedules } from '../../apps/worker/src/queue/handlers'

/**
 * Retention: §24.9, and the §14 requirements the queue migration had to preserve.
 *
 * This is the only scheduled job in the repository that destroys customer data, and the two
 * properties §14 names are the two that decide *whose* data:
 *
 *  - **The stored `plan` column is authoritative.** Every other entitlement check computes the
 *    effective plan so a lapsed subscription stops granting access immediately. Here that would
 *    mean the 02:25 sweep destroys a paying customer's month of history because their card
 *    expired at 02:00. So there is a test that a `pro` row whose `plan_expires_at` is in the
 *    past still gets pro retention, and it runs in the same sweep as a `free` row that does get
 *    swept — a sweep that had switched to dynamic resolution would delete both.
 *
 *  - **`FOR UPDATE OF e SKIP LOCKED` is preserved.** It is what lets two worker replicas divide
 *    an hourly sweep instead of blocking on each other. Asserting it needs a genuinely
 *    conflicting lock rather than a second call, so one test holds a row lock on another
 *    connection for the length of a real sweep and then reads what survived.
 *
 * Neither is observable from the outside. Both are asserted against the rows.
 *
 * The suite also reads back the three cron registrations. Under `node-cron` "is it scheduled?"
 * was answerable only by reading the source; they are rows in `pgboss.schedule` now, and a
 * mistyped expression or a dropped timezone would not fail a boot — it would sweep at the wrong
 * hour, or at whatever the host clock thinks 9am is. Retention's own cron is the reason that
 * test lives here; it asserts all three because `registerSchedules` writes them in one call and
 * checking the other two costs nothing.
 *
 * Ages are derived from the catalogue rather than written as hours, so a change to a published
 * retention window cannot leave these tests passing against the wrong boundary.
 */

const HOUR_MS = 60 * 60 * 1000

const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * HOUR_MS)

/** Comfortably past the window: an hour either side would race a slow test run. */
const expiredFor = (plan: keyof typeof PLANS): Date =>
  hoursAgo(PLANS[plan].retention_hours + 6)

const freshFor = (plan: keyof typeof PLANS): Date =>
  hoursAgo(PLANS[plan].retention_hours - 6)

/** The per-run ceiling the suite's configuration sets. Read, not assumed. */
const RUN_CAP = env.RETENTION_BATCH_SIZE * env.RETENTION_MAX_BATCHES_PER_RUN

/**
 * How long the lock-contention test is willing to wait for a sweep before calling it blocked.
 *
 * A sweep here is four small statements against a handful of rows — single-digit milliseconds —
 * so this is a very wide margin, and the failure it produces is a clean one either way.
 */
const SWEEP_PATIENCE = 5_000

/** An account on `plan`, with one endpoint. `planExpiresAt` is passed through untouched. */
const accountOn = async (
  plan: string,
  planExpiresAt: Date | null = null
): Promise<string> => {
  const userId = await createUser({ plan, planExpiresAt })
  return createEndpoint({ userId })
}

const eventsRemaining = async (endpointId: string): Promise<number> => {
  const row = await db().query(
    `select count(*)::int as n from events where endpoint_id = $1`,
    [endpointId]
  )
  return (row.rows[0] as { n: number }).n
}

const eventExists = async (eventId: string): Promise<boolean> => {
  const row = await db().query(`select 1 from events where id = $1`, [eventId])
  return row.rowCount === 1
}

/**
 * Bulk aged events, for the cap test only.
 *
 * `generate_series` rather than a loop of `createEvent`: reaching the per-run cap needs more
 * rows than the cap allows, and two hundred round trips per run is the difference between a
 * suite that gets run and one that does not.
 */
const createAgedEvents = async (
  endpointId: string,
  quantity: number,
  receivedAt: Date
): Promise<void> => {
  await db().query(
    `insert into events (endpoint_id, method, headers, body, source_ip, status, received_at)
     select $1, 'POST', '{}'::jsonb, '{"bulk":true}', '198.51.100.7', 'received', $2
       from generate_series(1, $3)`,
    [endpointId, receivedAt, quantity]
  )
}

describe('retention', () => {
  before(async () => {
    await startTestQueue()
    await initDB()
  })

  beforeEach(async () => {
    await reset()
  })

  after(async () => {
    await stopTestQueue()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
    await closeDatabase()
  })

  it("removes events past the plan's window and keeps the rest", async () => {
    const endpointId = await accountOn('free')
    const expired = await createEvent({
      endpointId,
      receivedAt: expiredFor('free'),
    })
    const recent = await createEvent({
      endpointId,
      receivedAt: freshFor('free'),
    })

    await enforceRetention()

    assert.equal(await eventExists(expired), false)
    assert.equal(await eventExists(recent), true)
  })

  /**
   * §14, the stored plan column.
   *
   * Both accounts hold an event of the same age, and the only difference between them is the
   * `plan` value on the row. If retention resolved the effective plan the way access checks do,
   * the expired `pro` subscription would be treated as `free` and this event — inside pro's
   * window and outside free's — would be gone. The downgrade is `subscription.scheduler.ts`'s
   * to write, after two reminder emails and an expiry notice, and it is reversible by a renewal
   * until it is written. Deletion is not reversible by anything.
   */
  it('follows the plan column on the row, not the subscription expiry', async () => {
    const lapsedPro = await accountOn('pro', hoursAgo(48))
    const free = await accountOn('free')

    const age = expiredFor('free')
    const proEvent = await createEvent({
      endpointId: lapsedPro,
      receivedAt: age,
    })
    const freeEvent = await createEvent({ endpointId: free, receivedAt: age })

    await enforceRetention()

    assert.equal(
      await eventExists(proEvent),
      true,
      'an expired pro subscription still holds pro retention until the downgrade is written'
    )
    assert.equal(
      await eventExists(freeEvent),
      false,
      'the same age on a free row is past its window'
    )
  })

  it('applies each tier its own window in a single run', async () => {
    /** Past free's 24h, inside starter's 168h and pro's 720h. */
    const age = hoursAgo(PLANS.free.retention_hours + 6)

    const free = await accountOn('free')
    const starter = await accountOn('starter')
    const pro = await accountOn('pro')

    const freeEvent = await createEvent({ endpointId: free, receivedAt: age })
    const starterEvent = await createEvent({
      endpointId: starter,
      receivedAt: age,
    })
    const proEvent = await createEvent({ endpointId: pro, receivedAt: age })

    await enforceRetention()

    assert.equal(await eventExists(freeEvent), false)
    assert.equal(await eventExists(starterEvent), true)
    assert.equal(await eventExists(proEvent), true)
  })

  /**
   * A `users.plan` the catalogue does not know about — a hand-edited row, or a tier added to
   * the database ahead of the code. There is no retention window this job is willing to invent
   * for it, so the events stay and the value is named in the log. Keeping data that should have
   * gone is a storage bill; deleting it on a guess is not recoverable.
   */
  it('keeps events on an unrecognised plan and names the value', async (t) => {
    const endpointId = await accountOn('enterprise')
    const ancient = await createEvent({
      endpointId,
      receivedAt: hoursAgo(10_000),
    })
    const logged = captureConsole(t)

    await enforceRetention()

    assert.equal(await eventExists(ancient), true)
    const output = logged()
    assert.match(output, /unrecognised plan value\(s\): enterprise/)
    assert.match(output, /kept indefinitely/)
  })

  /**
   * The cascade. `deliveries` and `ai_insights` both declare `event_id … ON DELETE CASCADE`,
   * which is what makes deleting an event sufficient — a sweep that left delivery rows behind
   * would accumulate orphans referencing an event nobody can look at.
   */
  it('takes the delivery attempts with the event', async () => {
    const endpointId = await accountOn('free')
    const destinationId = await createDestination({ endpointId })
    const eventId = await createEvent({
      endpointId,
      receivedAt: expiredFor('free'),
    })
    await createDelivery({
      eventId,
      destinationId,
      status: 'delivered',
      attemptCount: 1,
      responseCode: 200,
    })

    assert.equal((await deliveriesFor(eventId)).length, 1)

    await enforceRetention()

    assert.equal(await eventExists(eventId), false)
    assert.equal((await deliveriesFor(eventId)).length, 0)
  })

  /**
   * §14, `FOR UPDATE OF e SKIP LOCKED`.
   *
   * A second transaction holds a row lock on one of three eligible events across a real sweep.
   * `SKIP LOCKED` means the sweep steps over that row and takes the other two; without it the
   * same statement blocks until the lock is released, which in production is one replica stalled
   * behind another for the length of its sweep and, on a busy account, two hourly runs
   * overlapping.
   *
   * The sweep is raced against a patience window rather than simply awaited, because losing that
   * clause makes the statement *wait* rather than fail — see `holdEventLock`. Winning the race is
   * the assertion that names the property; the row counts then say which rows it took.
   *
   * `SWEEP_PATIENCE` is the suite's only timing dependency. These sweeps are four small
   * statements against a handful of rows, so the margin is three orders of magnitude, and losing
   * the race is a clean failure rather than a flake that hangs.
   */
  it('steps over an event another transaction has locked', async () => {
    const endpointId = await accountOn('free')
    const age = expiredFor('free')
    const locked = await createEvent({ endpointId, receivedAt: age })
    await createEvent({ endpointId, receivedAt: age })
    await createEvent({ endpointId, receivedAt: age })

    const lock = await holdEventLock(locked)
    const patience = new AbortController()

    try {
      const finished = await Promise.race([
        enforceRetention().then(() => true),
        delay(SWEEP_PATIENCE, false, { signal: patience.signal }).catch(
          () => false
        ),
      ])
      patience.abort()

      assert.ok(
        finished,
        'the sweep must step over the locked row rather than wait for it'
      )
      assert.equal(await eventExists(locked), true)
      assert.equal(
        await eventsRemaining(endpointId),
        1,
        'the two unlocked rows should have gone'
      )
    } finally {
      await lock.release()
    }
  })

  /**
   * The per-run cap, which bounds the blast radius of a single sweep.
   *
   * When a large backlog first becomes eligible — the first run after this job was deployed, or
   * a tier downgrade on a busy account — the deletion is spread over several hourly runs, and
   * each one says in the log that it stopped early. That warning is the whole mechanism: it is
   * what gives an operator hours to set `RETENTION_ENABLED=false` rather than discovering the
   * deletion afterwards. A sweep that silently stopped at the cap would look exactly like a
   * sweep that had finished, so the log line is asserted alongside the row count.
   */
  it('stops at the per-run cap and reports that events remain', async (t) => {
    const endpointId = await accountOn('free')
    await createAgedEvents(endpointId, RUN_CAP + 1, expiredFor('free'))
    const logged = captureConsole(t)

    await enforceRetention()

    assert.equal(
      await eventsRemaining(endpointId),
      1,
      'exactly the cap should have been removed'
    )
    const output = logged()
    assert.match(output, /per-run cap reached, more remain/)
    assert.match(output, /Eligible events remain/)
  })

  it('reports a run with nothing to remove', async (t) => {
    const endpointId = await accountOn('free')
    const recent = await createEvent({
      endpointId,
      receivedAt: freshFor('free'),
    })
    const logged = captureConsole(t)

    await enforceRetention()

    assert.equal(await eventExists(recent), true)
    assert.match(logged(), /Retention: nothing to remove/)
  })

  /**
   * §14's `cron → pg-boss job → worker handler`, at the registration end.
   *
   * The data payload is null for all three: a scheduled sweep takes no arguments, and the
   * handlers ignore what they are given. Asserting it keeps a future change from smuggling
   * configuration through the schedule row, where nothing validates it.
   */
  it('registers the three recurring sweeps with their timezone', async (t) => {
    const boss = await startTestQueue()
    t.after(async () => {
      await resetSchedules()
    })

    await registerSchedules(boss)

    const retention = await scheduleOf(QUEUES.retention)
    assert.equal(retention?.cron, RETENTION_CRON)
    assert.equal(retention?.timezone, env.SCHEDULER_TIMEZONE)
    assert.equal(retention?.data, null)

    const expiry = await scheduleOf(QUEUES.subscriptionExpiry)
    assert.equal(expiry?.cron, SUBSCRIPTION_EXPIRY_CRON)
    assert.equal(expiry?.timezone, env.SCHEDULER_TIMEZONE)

    const demo = await scheduleOf(QUEUES.demoCleanup)
    assert.equal(demo?.cron, DEMO_CLEANUP_CRON)
    assert.equal(demo?.timezone, env.SCHEDULER_TIMEZONE)

    // Offset from each other on purpose: two hourly jobs deleting from `events` on the same
    // tick would contend for the same pages for no reason.
    assert.notEqual(RETENTION_CRON, DEMO_CLEANUP_CRON)
  })
})
