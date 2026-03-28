import 'reflect-metadata'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import dotenv from 'dotenv'
import { initDB } from './db'
import ingestRouter from './routes/ingest'

dotenv.config({ path: '../../.env' })

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

const start = async (): Promise<void> => {
  await initDB()
  httpServer.listen(PORT, () => {
    console.log(`Ingestion service running on port ${PORT}`)
  })
}

start()
