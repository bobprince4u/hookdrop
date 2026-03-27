import 'reflect-metadata'
import dotenv from 'dotenv'
import { initDB } from './db'
import { startDeliveryWorker } from './workers/delivery.worker'

dotenv.config({ path: '../../.env' })

const start = async (): Promise<void> => {
  await initDB()
  startDeliveryWorker()
  console.log('Hookdrop worker service running')
}

start()
