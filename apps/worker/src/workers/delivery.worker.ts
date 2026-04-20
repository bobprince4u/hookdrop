import { Worker } from 'bullmq'
import { redis } from '../queue'
import { processDelivery } from '../processors/delivery.processor'

export const startDeliveryWorker = () => {
  const worker = new Worker(
    'delivery',
    processDelivery,
    {
      connection: redis,
      stalledInterval: 30000,
      maxStalledCount: 2,
    }
  )

  worker.on('failed', (job, err) => {
    console.error(`Delivery job ${job?.id} failed:`, err)
  })

  console.log('Delivery worker started')
}
