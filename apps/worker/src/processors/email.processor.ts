import type { JobWithMetadata } from 'pg-boss'
import { EMAIL_TEMPLATES, EmailJob } from '../queue/contract'
import {
  sendDay1TipsEmail,
  sendDay3UpgradeEmail,
} from '../services/email.service'

/**
 * Welcome-sequence email jobs.
 *
 * BullMQ distinguished the two templates by *job name* on a shared `email` queue. pg-boss
 * has no job name — the queue is the name — so the template moved into the payload as
 * `EmailJob.template` and this processor dispatches on it. That keeps one email consumer
 * with one concurrency bound, exactly as before, and it keeps the two producers from having
 * to agree on a second naming convention.
 *
 * No secret is read from the payload: the Resend API key comes from validated configuration
 * inside `email.service`, and the recipient address is the only personal data present
 * because there is no way to send an email without it.
 */
export const processEmail = async (
  job: JobWithMetadata<EmailJob>
): Promise<void> => {
  const { template, email, name } = job.data

  /**
   * Payload data is validated rather than trusted. It arrives from a `jsonb` column, so it
   * may have been written by an older producer or edited in the database, and an `email`
   * job with a missing address previously reached Resend as `to: undefined` — which fails,
   * retries three more times, and reports a transport error rather than the real problem.
   */
  if (typeof email !== 'string' || email.length === 0) {
    throw new Error(`Email job ${job.id} has no recipient address`)
  }

  const recipientName = typeof name === 'string' ? name : ''

  switch (template) {
    case 'day1-tips':
      await sendDay1TipsEmail(email, recipientName)
      break
    case 'day3-upgrade':
      await sendDay3UpgradeEmail(email, recipientName)
      break
    default:
      /**
       * Unknown templates used to be silently discarded: both `if` branches failed to
       * match, the processor returned normally, and the job was marked complete. Failing
       * loudly is what surfaces a producer/consumer mismatch — the same class of silent
       * failure the drift check on `queue/contract.ts` exists to prevent.
       */
      throw new Error(
        `Email job ${job.id} has unknown template ${JSON.stringify(template)}; ` +
          `expected one of: ${EMAIL_TEMPLATES.join(', ')}`
      )
  }

  // Template and job id only. The recipient address is not written to the log (H-48).
  console.log(`Email sent: job=${job.id} template=${template}`)
}
