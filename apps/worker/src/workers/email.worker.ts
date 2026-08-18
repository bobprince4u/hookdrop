import { Worker } from 'bullmq'
import { redis } from '../queue'
import { env } from '../config/env'
import {
  sendDay1TipsEmail,
  sendDay3UpgradeEmail,
} from '../services/email.service'

export const startEmailWorker = (): Worker => {
  const worker = new Worker(
    'email',
    async (job) => {
      const { email, name } = job.data as { email?: string; name?: string }

      /**
       * Job data is validated rather than trusted. An `email` job with a missing address
       * previously reached Resend as `to: undefined`, which fails, retries three more
       * times, and reports a transport error instead of the actual problem.
       */
      if (typeof email !== 'string' || email.length === 0) {
        throw new Error(`Email job ${job.id} has no recipient address`)
      }
      const recipientName = typeof name === 'string' ? name : ''

      switch (job.name) {
        case 'day1-tips':
          await sendDay1TipsEmail(email, recipientName)
          break
        case 'day3-upgrade':
          await sendDay3UpgradeEmail(email, recipientName)
          break
        default:
          /**
           * Unknown job names used to be silently discarded — both `if` blocks failed to
           * match, the processor returned normally, and BullMQ marked the job complete.
           * Failing loudly is what surfaces a producer/consumer mismatch.
           */
          throw new Error(`Unknown email job name: ${job.name}`)
      }
    },
    {
      connection: redis,
      concurrency: env.EMAIL_CONCURRENCY,
      // Check stalled jobs every 60s rather than the 5s default.
      stalledInterval: 60_000,
      maxStalledCount: 2,
    }
  )

  worker.on('failed', (job, err) => {
    // Message only: the error object would carry the full Resend request, API key included.
    console.error(`Email job ${job?.id} (${job?.name}) failed: ${err.message}`)
  })

  worker.on('error', (err) => {
    console.error('Email worker error:', err.message)
  })

  console.log(`Email worker started (concurrency ${env.EMAIL_CONCURRENCY})`)

  return worker
}
