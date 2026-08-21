import '../support/env'

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { TestContext } from 'node:test'

import type { JobWithMetadata } from 'pg-boss'

import { captureConsole } from '../support/console'
import { closeDatabase, reset } from '../support/database'
import {
  QUEUES,
  asHandlerJob,
  jobCountOn,
  jobsOn,
  onlyJobOn,
  startTestQueue,
  stopTestQueue,
} from '../support/queue'
import type { JobRow } from '../support/queue'
import {
  EMAIL_TEMPLATES,
  publishEmail,
} from '../../apps/worker/src/queue/contract'
import type {
  EmailJob,
  EmailTemplate,
} from '../../apps/worker/src/queue/contract'
import { processEmail } from '../../apps/worker/src/processors/email.processor'
import * as workerEmail from '../../apps/worker/src/services/email.service'
import * as apiQueue from '../../apps/api/src/queue'
import { sendWelcomeSequence } from '../../apps/api/src/services/email.service'

/**
 * Email jobs: §24.10, and the §13 requirement that the migration preserve retry, idempotency
 * and failure handling rather than quietly dropping the feature.
 *
 * The migration changed how a template is identified. BullMQ distinguished the two onboarding
 * emails by *job name* on a shared `email` queue; pg-boss has no job name — the queue is the
 * name — so the template moved into the payload and the consumer dispatches on it. That is a
 * producer/consumer contract with no compiler between the halves: the payload arrives back
 * from a `jsonb` column, and a template the producer sends but the processor has no case for
 * would previously have been marked complete and silently discarded. So the suite runs the
 * real API producer and the real worker consumer against the same queue.
 *
 * Both services are loaded, as in `tests/api/replay.test.ts`, but neither data source is:
 * `sendWelcomeSequence` publishes and nothing else, so the only infrastructure it needs is a
 * started pg-boss. The worker's instance is started first because it owns the schema and
 * registers the queues; the API's is publish-only and refuses to create either.
 *
 * ## What is and is not observable here
 *
 * `tests/support/env.ts` blanks `RESEND_API_KEY`, so the worker's mail client is `null`, its
 * `send()` returns early, and nothing leaves the machine. That is deliberate — a test that
 * actually sent mail would have an effect outside the process — and it means the seam is the
 * processor's *dispatch*, not the provider call: which builder each template reaches, with
 * which recipient. The builders themselves are seven HTML templates over one `send()` helper
 * and are not what the queue migration touched.
 *
 * The same blanking is why nothing here asserts on provider failure handling. The worker's
 * `email.service.send()` swallows every provider error by design — pre-existing behaviour,
 * preserved — so a Resend outage never reaches the processor and never consumes the queue's
 * retry budget. What does reach the queue is a failure to dispatch at all, which is tested
 * below.
 *
 * `EMAIL_QUEUE`'s registered retry policy and the delay arithmetic on a single publish are
 * asserted in `queue-publish.test.ts` and not repeated.
 */

/**
 * Which builder each template is required to reach.
 *
 * Declared here rather than inferred, because the property under test is exactly this
 * mapping: a template added to the contract without a matching `case` in the processor has to
 * fail a test rather than reach production and throw on the first real job.
 */
type BuilderName = 'sendDay1TipsEmail' | 'sendDay3UpgradeEmail'

const BUILDER_FOR: Record<EmailTemplate, BuilderName> = {
  'day1-tips': 'sendDay1TipsEmail',
  'day3-upgrade': 'sendDay3UpgradeEmail',
}

interface BuilderCall {
  email: string
  name: string
}

/**
 * Replaces both template builders and records what they were handed.
 *
 * The processor calls them through the module object — `import { sendDay1TipsEmail }` compiles
 * to a property lookup at call time — so redefining the export intercepts the real call path
 * rather than a copy of it. `t.mock` restores them when the test ends.
 */
const stubBuilders = (t: TestContext): Record<BuilderName, BuilderCall[]> => {
  const calls: Record<BuilderName, BuilderCall[]> = {
    sendDay1TipsEmail: [],
    sendDay3UpgradeEmail: [],
  }

  for (const builder of Object.keys(calls) as BuilderName[]) {
    t.mock.method(
      workerEmail,
      builder,
      async (email: string, name: string): Promise<void> => {
        calls[builder].push({ email, name })
      }
    )
  }

  return calls
}

/** A well-formed job, published through the producer the services actually use. */
const publishOne = async (
  data: EmailJob,
  options: { startAfterSeconds?: number } = {}
): Promise<JobWithMetadata<EmailJob>> => {
  const boss = await startTestQueue()
  await publishEmail(boss, data, options)
  return asHandlerJob(await onlyJobOn<EmailJob>(QUEUES.email))
}

/**
 * A job whose payload the typed producer could not have produced.
 *
 * `EmailJob` makes `template` a union and both string fields required, so none of the
 * malformed payloads below can go through `publishEmail`. They are sent straight to the queue
 * and cast at this one point, which is honest about where the processor's validation is
 * actually needed: `job.data` comes back out of a `jsonb` column written by whichever producer
 * version was deployed at the time, and TypeScript has no say in what is in it.
 */
const publishRaw = async (
  data: Record<string, unknown>
): Promise<JobWithMetadata<EmailJob>> => {
  const boss = await startTestQueue()
  await boss.send(QUEUES.email, data)
  return asHandlerJob(await onlyJobOn<EmailJob>(QUEUES.email))
}

/** Distinctive enough that a substring check for it in the log means something. */
const RECIPIENT = 'ada.lovelace@example.invalid'
const RECIPIENT_NAME = 'Ada Lovelace'

const emailJobs = async (): Promise<JobRow<EmailJob>[]> =>
  jobsOn<EmailJob>(QUEUES.email)

const jobFor = (
  jobs: JobRow<EmailJob>[],
  template: EmailTemplate
): JobRow<EmailJob> => {
  const matching = jobs.filter((job) => job.data.template === template)
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly one "${template}" job, found ${matching.length}`
    )
  }
  return matching[0] as JobRow<EmailJob>
}

const HOUR_SECONDS = 60 * 60

/** ±10 minutes, which is three orders of magnitude wider than the publish takes. */
const startsAboutAfter = (job: JobRow<EmailJob>, seconds: number): boolean => {
  const actual = (job.start_after.getTime() - Date.now()) / 1000
  return Math.abs(actual - seconds) < 600
}

describe('email jobs', () => {
  before(async () => {
    await startTestQueue()
    await apiQueue.startQueue()
  })

  beforeEach(async () => {
    await reset()
  })

  after(async () => {
    await apiQueue.closeQueue()
    await stopTestQueue()
    await closeDatabase()
  })

  it('has a builder for every template the contract publishes', () => {
    assert.deepEqual(
      Object.keys(BUILDER_FOR).sort(),
      [...EMAIL_TEMPLATES].sort(),
      'a template in the contract with no builder here is one the processor may not handle either'
    )
  })

  /**
   * §13 at the producer end.
   *
   * Under BullMQ these were two `emailQueue.add(name, …)` calls with a `delay` in
   * milliseconds; they are one queue with a template in the payload and `startAfter` in
   * seconds now. Both jobs and both delays are asserted because the unit change is the kind
   * of mistake that produces a plausible-looking job — a 24-hour email scheduled 24 seconds
   * out arrives while the user is still reading the welcome message, and a 1000× error in the
   * other direction schedules it for 2029.
   */
  it('schedules both onboarding emails on the one email queue', async () => {
    await sendWelcomeSequence(RECIPIENT, RECIPIENT_NAME)

    const jobs = await emailJobs()
    assert.equal(jobs.length, 2)

    const day1 = jobFor(jobs, 'day1-tips')
    const day3 = jobFor(jobs, 'day3-upgrade')

    for (const job of [day1, day3]) {
      assert.equal(job.name, QUEUES.email)
      assert.equal(job.data.email, RECIPIENT)
      assert.equal(job.data.name, RECIPIENT_NAME)
      assert.equal(job.state, 'created')
    }

    assert.ok(
      startsAboutAfter(day1, 24 * HOUR_SECONDS),
      `day1-tips should start about 24h out, got ${day1.start_after.toISOString()}`
    )
    assert.ok(
      startsAboutAfter(day3, 72 * HOUR_SECONDS),
      `day3-upgrade should start about 72h out, got ${day3.start_after.toISOString()}`
    )
  })

  /**
   * §13, failure handling — and a process-level one.
   *
   * `auth.controller.ts` calls this as `void sendWelcomeSequence(...)`, discarding the
   * promise, so a rejection here is an unhandled rejection and under Node's default that
   * terminates the API. Registration has already committed by then: the account exists, the
   * response may already be on the wire, and the thing that would kill the process is a
   * marketing email. So the function has to absorb its own failures, per template, and the
   * second must still be scheduled when the first fails.
   *
   * The failure is injected at `getBoss`, which is where an unstarted or stopped queue
   * actually surfaces, and only on the first call.
   */
  it('keeps scheduling after a publish failure and never rejects', async (t) => {
    const started = apiQueue.getBoss
    let attempts = 0

    t.mock.method(apiQueue, 'getBoss', () => {
      attempts += 1
      if (attempts === 1) throw new Error('queue is unreachable')
      return started()
    })

    const logged = captureConsole(t)

    await sendWelcomeSequence(RECIPIENT, RECIPIENT_NAME)

    assert.equal(attempts, 2, 'the second template must still be attempted')

    const jobs = await emailJobs()
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]?.data.template, 'day3-upgrade')

    const output = logged()
    assert.match(output, /Failed to schedule day1-tips email/)
    assert.match(output, /queue is unreachable/)
    assert.ok(
      !output.includes(RECIPIENT),
      'the recipient address must not be logged (H-48)'
    )
  })

  /**
   * §13 at the consumer end: the dispatch the queue migration introduced.
   *
   * Driven from `EMAIL_TEMPLATES` rather than a written-out list, so a third template cannot
   * be added to the contract without either a builder here or a failing test. Each job is
   * published through the real producer and adapted, so the payload the processor reads is
   * the one a producer writes.
   */
  it('sends each template through its own builder', async (t) => {
    const calls = stubBuilders(t)

    for (const template of EMAIL_TEMPLATES) {
      await reset()
      const job = await publishOne({
        template,
        email: RECIPIENT,
        name: RECIPIENT_NAME,
      })

      await processEmail(job)

      const builder = BUILDER_FOR[template]
      assert.deepEqual(
        calls[builder],
        [{ email: RECIPIENT, name: RECIPIENT_NAME }],
        `"${template}" should reach ${builder} exactly once`
      )
      calls[builder].length = 0

      for (const other of Object.values(BUILDER_FOR)) {
        if (other === builder) continue
        assert.equal(calls[other].length, 0, `${other} should not have run`)
      }
    }
  })

  /**
   * A payload from a producer that predates the `name` field, or one edited in the database.
   * The name is interpolated into the greeting, so the alternative to a default is
   * `Hi undefined,` in a customer's inbox.
   */
  it('substitutes an empty name when the payload has none', async (t) => {
    const calls = stubBuilders(t)
    const job = await publishRaw({ template: 'day1-tips', email: RECIPIENT })

    await processEmail(job)

    assert.deepEqual(calls.sendDay1TipsEmail, [{ email: RECIPIENT, name: '' }])
  })

  /**
   * A missing address used to reach Resend as `to: undefined`, which fails, retries three
   * more times over an hour of backoff, and reports a transport error rather than the real
   * problem. Failing before the provider call puts the actual cause in the log the first
   * time.
   */
  it('refuses a job with no recipient address', async (t) => {
    const calls = stubBuilders(t)
    const job = await publishRaw({ template: 'day1-tips', name: 'Nobody' })

    await assert.rejects(processEmail(job), /has no recipient address/)

    for (const builder of Object.values(BUILDER_FOR)) {
      assert.equal(
        calls[builder].length,
        0,
        'nothing should reach the provider without an address'
      )
    }
  })

  /**
   * The silent-discard regression.
   *
   * Both `if` branches used to fail to match, the processor returned normally, and pg-boss
   * marked the job complete — so a producer sending a template the consumer did not know
   * about looked, from every angle, like email that had been sent. Throwing is what surfaces
   * the mismatch, and the message has to name the value and the accepted set or the next
   * person is reading two files to find out what went wrong.
   */
  it('refuses a job with an unknown template', async (t) => {
    const calls = stubBuilders(t)
    const job = await publishRaw({
      template: 'monthly-digest',
      email: RECIPIENT,
      name: RECIPIENT_NAME,
    })

    await assert.rejects(processEmail(job), (error: Error) => {
      assert.match(error.message, /unknown template "monthly-digest"/)
      for (const template of EMAIL_TEMPLATES) {
        assert.ok(
          error.message.includes(template),
          `the message should list "${template}" as accepted`
        )
      }
      return true
    })

    for (const builder of Object.values(BUILDER_FOR)) {
      assert.equal(calls[builder].length, 0)
    }
  })

  /**
   * §13, retry handling.
   *
   * The only failures that can reach the queue are dispatch failures — the builders swallow
   * provider errors — and this is the assertion that they are not swallowed twice. A
   * processor that caught and logged instead of rethrowing would leave the queue's
   * `retryLimit: 3` inert: every job would complete on its first run whatever happened
   * inside it.
   */
  it('lets a dispatch failure reach the queue', async (t) => {
    t.mock.method(workerEmail, 'sendDay1TipsEmail', async (): Promise<void> => {
      throw new Error('template rendering failed')
    })

    const job = await publishOne({
      template: 'day1-tips',
      email: RECIPIENT,
      name: RECIPIENT_NAME,
    })

    await assert.rejects(processEmail(job), /template rendering failed/)

    const unchanged = await onlyJobOn<EmailJob>(QUEUES.email)
    assert.equal(
      unchanged.data.email,
      RECIPIENT,
      'the payload the retry will run with must be the one that was published'
    )
  })

  /**
   * §23 / H-48. Recipient addresses were logged on every successful send.
   *
   * This runs the real builder — with `RESEND_API_KEY` blank the client is `null` and
   * `send()` returns before touching the network — so the log line asserted is the one
   * production writes, and the check that the address is absent covers the builder's own
   * output as well as the processor's.
   */
  it('logs the job and template but never the recipient', async (t) => {
    const job = await publishOne({
      template: 'day1-tips',
      email: RECIPIENT,
      name: RECIPIENT_NAME,
    })
    const logged = captureConsole(t)

    await processEmail(job)

    const output = logged()
    assert.match(output, new RegExp(`job=${job.id}\\b`))
    assert.match(output, /template=day1-tips/)
    assert.ok(!output.includes(RECIPIENT), 'the address must not be logged')
    assert.ok(
      !output.includes(RECIPIENT_NAME),
      'the display name must not be logged either'
    )
  })

  /**
   * Idempotency, stated honestly rather than claimed.
   *
   * §10 is explicit that delivery is at-least-once, and email is the same mechanism with no
   * application-level guard: the processor holds no state, writes none, and re-running a job
   * sends the mail again. That is unchanged from BullMQ and it is the right trade here — the
   * consequence of a duplicate is a second copy of an onboarding tip, against a webhook
   * delivery where the consequence is a customer's system processing an order twice, which
   * is why `deliveries` carries the state that makes *that* path idempotent and this one does
   * not.
   *
   * The test exists so the property is recorded rather than assumed. If a dedupe key is ever
   * added, this is the test that has to be rewritten, deliberately.
   */
  it('re-runs a completed job rather than deduplicating it', async (t) => {
    const calls = stubBuilders(t)
    const job = await publishOne({
      template: 'day1-tips',
      email: RECIPIENT,
      name: RECIPIENT_NAME,
    })

    await processEmail(job)
    await processEmail(job)

    assert.equal(
      calls.sendDay1TipsEmail.length,
      2,
      'email is at-least-once: the processor does not deduplicate'
    )
    assert.equal(await jobCountOn(QUEUES.email), 1, 'and creates no new work')
  })
})
