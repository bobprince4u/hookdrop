import { Router, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { deliveryQueue, aiQueue } from '../queue'
import { io } from '../index'
import { ingestRateLimiter } from '../middleware/rateLimiter'
import crypto from 'crypto'
import axios from 'axios'

const router = Router()

const PLAN_LIMITS = {
  starter: { events_per_month: 10000 },
  free: { events_per_month: 500 },
  pro: { events_per_month: 100000 },
  team: { events_per_month: 500000 },
}

const checkLimit = async (
  endpointId: string,
  userId: string,
  plan: string
): Promise<{ withinLimit: boolean; count: number; limit: number }> => {
  const eventRepo = AppDataSource.getRepository(Event)
  const limits =
    PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] || PLAN_LIMITS.free

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const count = await eventRepo
    .createQueryBuilder('event')
    .innerJoin('event.endpoint', 'ep')
    .where('ep.user_id = :userId', { userId })
    .andWhere('event.received_at >= :startOfMonth', { startOfMonth })
    .getCount()

  return {
    withinLimit: count < limits.events_per_month,
    count,
    limit: limits.events_per_month,
  }
}
const handleIngest = async (req: Request, res: Response): Promise<void> => {
  const token = req.params.token as string

  try {
    const endpointRepo = AppDataSource.getRepository(Endpoint)

    const endpoint = await endpointRepo.findOne({
      where: { public_token: token, is_active: true },
      relations: ['user'],
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    // Check plan limits
    const { withinLimit, count, limit } = await checkLimit(
      endpoint.id,
      endpoint.user_id,
      endpoint.user?.plan || 'free'
    )
    if (!withinLimit) {
      res.status(429).json({
        error: 'Monthly event limit reached',
        plan: endpoint.user?.plan || 'free',
      })
      return
    }

    const eventRepo = AppDataSource.getRepository(Event)

    const event = eventRepo.create({
      endpoint_id: endpoint.id,
      method: req.method,
      headers: req.headers as object,
      body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
      source_ip: req.ip,
      status: 'received',
    })

    const savedEvent = await eventRepo.save(event)

    // Emit to dashboard in real time
    io.to(token).emit('new_event', savedEvent)

    await deliveryQueue.add(
      'deliver',
      { eventId: savedEvent.id, endpointId: endpoint.id },
      {
        attempts: 4,
        backoff: { type: 'exponential', delay: 5000 },
      }
    )

    await aiQueue.add('explain', { eventId: savedEvent.id })

    // Check if user is approaching plan limit (80%) and send warning
    const PLAN_LIMITS: Record<string, number> = {
      free: 500,
      starter: 10000,
      pro: 100000,
      team: 500000,
    }
    // const limit = PLAN_LIMITS[endpoint.user?.plan || 'free'] || 500
    const warningThreshold = Math.floor(limit * 0.8)

    if (count + 1 === warningThreshold) {
      try {
        const { sendPlanLimitWarningEmail } =
          await import('../services/email.service')

        if (endpoint.user) {
          await sendPlanLimitWarningEmail(
            endpoint.user.email,
            endpoint.user.name,
            count + 1,
            limit
          )
        }
      } catch (emailError) {
        console.error('Warning email failed:', emailError)
      }
    }

    res.status(200).json({ ok: true, eventId: savedEvent.id })
  } catch (error) {
    console.error('Ingestion error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/in/:token', ingestRateLimiter, handleIngest)
router.get('/in/:token', ingestRateLimiter, handleIngest)

export default router
