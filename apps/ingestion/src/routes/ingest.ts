import { Router, Request, Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { deliveryQueue, aiQueue } from '../queue'
import { io } from '../index'

const router = Router()

const handleIngest = async (req: Request, res: Response): Promise<void> => {
  const token = req.params.token as string

  try {
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const eventRepo = AppDataSource.getRepository(Event)

    const endpoint = await endpointRepo.findOne({
      where: { public_token: token, is_active: true },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

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
