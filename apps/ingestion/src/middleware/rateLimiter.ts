import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import type { RedisReply } from 'rate-limit-redis'
import { redis } from '../queue'

export const ingestRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per token
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `rate:${req.params.token}`,
  store: new RedisStore({
    sendCommand: (command: string, ...args: string[]) =>
      redis.call(command, ...args) as unknown as Promise<RedisReply>,
  }),
  handler: (_req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: '60 requests per minute allowed on free tier',
      retry_after: 60,
    })
  },
})
