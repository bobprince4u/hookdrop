import { Worker } from 'bullmq'
import IORedis from 'ioredis'
import { processDelivery } from '../processors/delivery.processor'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const redis = new IORedis(
  process.env.REDIS_URL || 'redis://localhost:6379',
  { maxRetriesPerRequest: null }
)

export const startDeliveryWorker = (): Worker => {
  const worker = new Worker('delivery', processDelivery, {
    connection: redis,
    concurrency: 5, // Process 5 jobs at the same time
  })

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`)
  })

  worker.on('failed', (job, error) => {
    console.error(`Job ${job?.id} failed:`, error.message)
  })

  worker.on('error', (error) => {
    console.error('Worker error:', error)
  })

  console.log('Delivery worker started — listening for jobs')
  return worker
}
