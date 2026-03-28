import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import dotenv from 'dotenv'
import { initDB } from './db'
import ingestRouter from './routes/ingest'

dotenv.config({ path: '../../.env' })

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
})

const app = express()
const httpServer = createServer(app)
const PORT = process.env.INGESTION_PORT || 3002

export const io = new Server(httpServer, {
  cors: { origin: '*' },
})

app.use(express.text({ type: '*/*' }))
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ingestion' })
})

app.use('/', ingestRouter)

app.use(Sentry.expressErrorHandler())

const start = async (): Promise<void> => {
  await initDB()
  httpServer.listen(PORT, () => {
    console.log(`Ingestion service running on port ${PORT}`)
  })
}

start()
