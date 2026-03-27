import 'reflect-metadata'
import express from 'express'
import dotenv from 'dotenv'
import { initDB } from './db'
import ingestRouter from './routes/ingest'

dotenv.config({ path: '../../.env' })

const app = express()
const PORT = process.env.INGESTION_PORT || 3002

app.use(express.text({ type: '*/*' }))
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ingestion' })
})

app.use('/', ingestRouter)

const start = async (): Promise<void> => {
  await initDB()
  app.listen(PORT, () => {
    console.log(`Ingestion service running on port ${PORT}`)
  })
}

start()
