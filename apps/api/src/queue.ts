import { Queue } from 'bullmq'
import IORedis from 'ioredis'

const connection = new IORedis()

export const emailQueue = new Queue('email', { connection })
