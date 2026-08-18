import { Worker } from 'bullmq'
import { redis } from '../queue'
import { env } from '../config/env'
import { processDelivery } from '../processors/delivery.processor'

/**
 * Returns the worker so the entrypoint can close it on shutdown. Previously it was created
 * and dropped, leaving no handle to drain in-flight jobs with — a redeploy killed the
 * process mid-delivery and the job was only recovered later by the stalled-job check.
 */
export const startDeliveryWorker = (): Worker => {
  const worker = new Worker('delivery', processDelivery, {
    connection: redis,
    concurrency: env.DELIVERY_CONCURRENCY,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  })

  worker.on('failed', (job, err) => {
    /**
     * `err` is logged by message rather than as an object. The delivery processor throws a
     * message it composed itself, and an axios error object serialises its whole
     * `config` — including request headers, which carry the destination's HMAC signature
     * (H-48).
     */
    console.error(
      `Delivery job ${job?.id} failed (attempt ${job?.attemptsMade ?? 0}): ${err.message}`
    )
  })

  worker.on('error', (err) => {
    console.error('Delivery worker error:', err.message)
  })

  console.log(
    `Delivery worker started (concurrency ${env.DELIVERY_CONCURRENCY})`
  )

  return worker
}
