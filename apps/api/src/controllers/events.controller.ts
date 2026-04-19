import { Response } from 'express'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Endpoint } from '../entities/Endpoint'
import { Delivery } from '../entities/Delivery'
import { AuthRequest } from '../middleware/auth'
import { deliveryQueue } from '../queue/index'

export const listEvents = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const eventRepo = AppDataSource.getRepository(Event)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const page = parseInt(req.query.page as string) || 1
    const limit = parseInt(req.query.limit as string) || 50
    const status = req.query.status as string
    const skip = (page - 1) * limit

    const queryBuilder = eventRepo
      .createQueryBuilder('event')
      .where('event.endpoint_id = :endpointId', { endpointId: id })
      .orderBy('event.received_at', 'DESC')
      .skip(skip)
      .take(limit)

    if (status) {
      queryBuilder.andWhere('event.status = :status', { status })
    }

    if (req.query.from) {
      queryBuilder.andWhere('event.received_at >= :from', {
        from: new Date(req.query.from as string),
      })
    }

    if (req.query.q) {
      queryBuilder.andWhere('event.body ILIKE :q', {
        q: `%${req.query.q}%`,
      })
    }

    const [events, total] = await queryBuilder.getManyAndCount()

    res.json({
      events,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('List events error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const getEvent = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const eId = req.params.eId as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const eventRepo = AppDataSource.getRepository(Event)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const event = await eventRepo.findOne({
      where: { id: eId, endpoint_id: id },
      relations: ['deliveries'],
    })

    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }

    res.json({ event })
  } catch (error) {
    console.error('Get event error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const replayEvent = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const eId = req.params.eId as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const eventRepo = AppDataSource.getRepository(Event)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const event = await eventRepo.findOne({
      where: { id: eId, endpoint_id: id },
    })

    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }

    await eventRepo.update(event.id, { status: 'received' })

    const job = await deliveryQueue.add(
      'deliver',
      { eventId: event.id, endpointId: endpoint.id },
      {
        attempts: 4,
        backoff: { type: 'exponential', delay: 5000 },
      }
    )

    res.json({ ok: true, jobId: job.id })
  } catch (error) {
    console.error('Replay event error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const getEventDeliveries = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const eId = req.params.eId as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const deliveryRepo = AppDataSource.getRepository(Delivery)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const deliveries = await deliveryRepo.find({
      where: { event_id: eId },
      relations: ['destination'],
      order: { created_at: 'DESC' },
    })

    res.json({ deliveries })
  } catch (error) {
    console.error('Get deliveries error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
