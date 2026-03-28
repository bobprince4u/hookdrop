import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import dotenv from 'dotenv'
import { initDB } from './db'
import { startDeliveryWorker } from './workers/delivery.worker'

dotenv.config({ path: '../../.env' })

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
})

const start = async (): Promise<void> => {
  await initDB()
  startDeliveryWorker()
  console.log('Hookdrop worker service running')
}

start()
