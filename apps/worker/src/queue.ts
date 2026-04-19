import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

export const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
})

export const deliveryQueue = new Queue('delivery', { connection: redis })
export const emailQueue = new Queue('email', { connection: redis })
