import 'reflect-metadata'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import helmet from 'helmet'
import dotenv from 'dotenv'
import { initDB } from './db'
import router from './routes'

dotenv.config({ path: '../../.env' })

const app = express()
const httpServer = createServer(app)
const PORT = process.env.API_PORT || 3000

// Socket.io setup
export const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})

// Middleware
app.use(helmet())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// CORS headers
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  next()
})

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api' })
})

// API routes
app.use('/api', router)

// WebSocket — join room by endpoint token
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
