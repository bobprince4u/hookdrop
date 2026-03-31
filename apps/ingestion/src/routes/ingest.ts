import { Router, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { deliveryQueue, aiQueue } from '../queue'
import { io } from '../index'
import crypto from 'crypto'
import axios from 'axios'

const router = Router()

const PLAN_LIMITS = {
  starter: { events_per_month: 10000 },
  free: { events_per_month: 500 },
  pro: { events_per_month: 100000 },
  team: { events_per_month: 500000 },
}

const checkLimit = async (endpointId: string, userId: string, plan: string): Promise<boolean> => {
  const eventRepo = AppDataSource.getRepository(Event)
  const limits = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] || PLAN_LIMITS.free

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const count = await eventRepo
    .createQueryBuilder('event')
    .innerJoin('event.endpoint', 'ep')
    .where('ep.user_id = :userId', { userId })
    .andWhere('event.received_at >= :startOfMonth', { startOfMonth })
    .getCount()

  return count < limits.events_per_month
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
    const withinLimit = await checkLimit(
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

    res.status(200).json({ ok: true, eventId: savedEvent.id })
  } catch (error) {
    console.error('Ingestion error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

router.post('/in/:token', handleIngest)
router.get('/in/:token', handleIngest)

export default router
