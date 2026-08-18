import { Response } from 'express'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Endpoint } from '../entities/Endpoint'
import { Delivery } from '../entities/Delivery'
import { AuthRequest } from '../middleware/auth'
import { deliveryQueue } from '../queue'
import { validatedQuery } from '../middleware/validate'
import type { EventQuery } from '../validation/schemas'

/**
 * Loads an endpoint only if it belongs to the caller.
 *
 * Every handler in this file goes through here first. Returning `null` (and letting
 * the caller answer 404) means an endpoint owned by another tenant is
 * indistinguishable from one that does not exist.
 */
const findOwnedEndpoint = async (
  endpointId: string,
  userId: string
): Promise<Endpoint | null> =>
  AppDataSource.getRepository(Endpoint).findOne({
    where: { id: endpointId, user_id: userId },
  })

export const listEvents = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpoint = await findOwnedEndpoint(id, req.user!.id)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    /**
     * Query params are validated and clamped by `eventQuerySchema` (page ≥ 1,
     * limit 1–100, `q` ≤ 200 chars). Previously `parseInt` accepted any integer,
     * so `?limit=1000000` was a one-request denial of service (H-20).
     */
    const query = validatedQuery<EventQuery>(req)

    const queryBuilder = AppDataSource.getRepository(Event)
      .createQueryBuilder('event')
      .where('event.endpoint_id = :endpointId', { endpointId: endpoint.id })
      .orderBy('event.received_at', 'DESC')
      .skip((query.page - 1) * query.limit)
      .take(query.limit)

    if (query.status) {
      queryBuilder.andWhere('event.status = :status', { status: query.status })
    }

    if (query.from) {
      queryBuilder.andWhere('event.received_at >= :from', { from: query.from })
    }

    if (query.to) {
      queryBuilder.andWhere('event.received_at <= :to', { to: query.to })
    }

    if (query.q) {
      // Parameterised, and the wildcards are escaped so a user-supplied `%` cannot
      // widen the scan to the whole table.
      queryBuilder.andWhere('event.body ILIKE :q', {
        q: `%${escapeLikePattern(query.q)}%`,
      })
    }

    const [events, total] = await queryBuilder.getManyAndCount()

    res.json({
      events,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.ceil(total / query.limit),
      },
    })
  } catch (error) {
    console.error('List events error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/** `%`, `_` and `\` are ILIKE metacharacters; treat the search term as literal. */
const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`)

export const getEvent = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const eId = req.params.eId as string

    const endpoint = await findOwnedEndpoint(id, req.user!.id)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const event = await AppDataSource.getRepository(Event).findOne({
      where: { id: eId, endpoint_id: endpoint.id },
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

    const endpoint = await findOwnedEndpoint(id, req.user!.id)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const eventRepo = AppDataSource.getRepository(Event)
    const event = await eventRepo.findOne({
      where: { id: eId, endpoint_id: endpoint.id },
    })

    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }

    /**
     * A replay must be able to re-deliver an event that already succeeded, so the
     * delivery rows for this event are reset to `pending` and their `delivered_at`
     * cleared. Without this the processor's idempotency check short-circuits and
     * the replay silently does nothing (H-08).
     */
    await AppDataSource.transaction(async (manager) => {
      await manager
        .getRepository(Delivery)
        .createQueryBuilder()
        .update(Delivery)
        .set({ status: 'pending', delivered_at: null, attempt_count: 0 })
        .where('event_id = :eventId', { eventId: event.id })
        .execute()

      await manager.getRepository(Event).update(event.id, { status: 'received' })
    })

    const job = await deliveryQueue.add(
      'deliver',
      { eventId: event.id, endpointId: endpoint.id, replay: true },
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

    const endpoint = await findOwnedEndpoint(id, req.user!.id)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    /**
     * The event must belong to the endpoint we just proved ownership of.
     *
     * Previously this queried `{ event_id: eId }` alone: any authenticated user who
     * owned any endpoint could pass another tenant's event id in the path and read
     * that event's destination URLs and response bodies (H-03).
     */
    const event = await AppDataSource.getRepository(Event).findOne({
      where: { id: eId, endpoint_id: endpoint.id },
      select: { id: true },
    })

    if (!event) {
      res.status(404).json({ error: 'Event not found' })
      return
    }

    const deliveries = await AppDataSource.getRepository(Delivery).find({
      where: { event_id: event.id },
      relations: ['destination'],
      order: { created_at: 'DESC' },
    })

    // The destination's signing secret is not part of a delivery report.
    const sanitised = deliveries.map((delivery) => ({
      ...delivery,
      destination: delivery.destination
        ? {
            id: delivery.destination.id,
            url: delivery.destination.url,
            is_active: delivery.destination.is_active,
            created_at: delivery.destination.created_at,
          }
        : null,
    }))

    res.json({ deliveries: sanitised })
  } catch (error) {
    console.error('Get deliveries error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
