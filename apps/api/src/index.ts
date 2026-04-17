import 'reflect-metadata'
import * as Sentry from '@sentry/node'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { initDB } from './db'
import router from './routes'

dotenv.config({ path: '../../.env' })

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
})

const app = express()
const httpServer = createServer(app)
const PORT = process.env.PORT || process.env.API_PORT || 3003

// Build allowed origins from env — supports multiple comma-separated URLs
const allowedOrigins = [
  'http://localhost:3004',
  'https://hookdropi.vercel.app',
  'https://hookdropi.qzz.io',
  process.env.FRONTEND_URL,
  ...(process.env.EXTRA_ORIGINS ? process.env.EXTRA_ORIGINS.split(',') : []),
].filter(Boolean) as string[]

console.log('Allowed origins:', allowedOrigins)

export const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin as string
  if (!origin || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*')
  }
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PATCH,PUT,DELETE,OPTIONS'
  )
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Credentials', 'true')
  if (req.method === 'OPTIONS') {
    res.sendStatus(200)
    return
  }
  next()
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api', env: process.env.NODE_ENV })
})

app.use('/api', router)

app.use(Sentry.expressErrorHandler())

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`)
  socket.on('join', (token: string) => {
    socket.join(token)
    console.log(`Client ${socket.id} joined room: ${token}`)
  })
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`)
  })
})

const start = async (): Promise<void> => {
  await initDB()
  httpServer.listen(PORT, () => {
    console.log(`API service running on port ${PORT}`)
  })
}

start()
