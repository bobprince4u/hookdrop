import { Job } from 'bullmq'
import axios from 'axios'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery } from '../entities/Delivery'

interface DeliveryJobData {
  eventId: string
  endpointId: string
}

export const processDelivery = async (
  job: Job<DeliveryJobData>
): Promise<void> => {
  const { eventId, endpointId } = job.data

  const eventRepo = AppDataSource.getRepository(Event)
  const destinationRepo = AppDataSource.getRepository(Destination)
  const deliveryRepo = AppDataSource.getRepository(Delivery)

  // Fetch the event
  const event = await eventRepo.findOne({
    where: { id: eventId },
  })

  if (!event) {
    console.error(`Event ${eventId} not found`)
    return
  }

  // Fetch all active destinations for this endpoint
  const destinations = await destinationRepo.find({
    where: { endpoint_id: endpointId, is_active: true },
  })

  if (destinations.length === 0) {
    console.log(`No destinations for endpoint ${endpointId}`)
    await eventRepo.update(eventId, { status: 'delivered' })
    return
  }

  // Forward to each destination
  for (const destination of destinations) {
    // Idempotency check — never deliver the same event twice
    const existing = await deliveryRepo.findOne({
      where: {
        event_id: eventId,
        destination_id: destination.id,
        status: 'delivered',
      },
    })

    if (existing) {
      console.log(`Event ${eventId} already delivered to ${destination.url}`)
      continue
    }

    // Create or find delivery record
    let delivery = await deliveryRepo.findOne({
      where: { event_id: eventId, destination_id: destination.id },
    })

    if (!delivery) {
      delivery = deliveryRepo.create({
        event_id: eventId,
        destination_id: destination.id,
        status: 'pending',
        attempt_count: 0,
      })
      delivery = await deliveryRepo.save(delivery)
    }

    try {
      // Forward the webhook
      const response = await axios.post(destination.url, event.body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Hookdrop-Event-Id': eventId,
          'X-Hookdrop-Attempt': String(job.attemptsMade + 1),
        },
        timeout: 10000, // 10 second timeout
        validateStatus: (status) => status < 500,
      })

      // Success
      await deliveryRepo.update(delivery.id, {
        status: 'delivered',
        response_code: response.status,
        response_body: JSON.stringify(response.data).substring(0, 1000),
        attempt_count: job.attemptsMade + 1,
        last_attempted_at: new Date(),
        delivered_at: new Date(),
      })

      console.log(
        `Delivered event ${eventId} to ${destination.url} — ${response.status}`
      )
    } catch (error: unknown) {
      const attemptCount = job.attemptsMade + 1
      const maxAttempts = 4

      if (attemptCount >= maxAttempts) {
        // Final failure — move to dead letter
        await deliveryRepo.update(delivery.id, {
          status: 'dead_letter',
          attempt_count: attemptCount,
          last_attempted_at: new Date(),
          response_body:
            error instanceof Error ? error.message : 'Unknown error',
        })

        await eventRepo.update(eventId, { status: 'failed' })
        console.error(
          `Event ${eventId} dead lettered after ${attemptCount} attempts`
        )

        // Send failure notification email
        try {
          const { sendDeliveryFailureEmail } =
            await import('../services/email.service')
          const fullEvent = await eventRepo.findOne({
            where: { id: eventId },
            relations: ['endpoint', 'endpoint.user'],
          })
          if (fullEvent?.endpoint?.user) {
            await sendDeliveryFailureEmail(
              fullEvent.endpoint.user.email,
              fullEvent.endpoint.user.name,
              fullEvent.endpoint.name,
              eventId,
              destination.url
            )
          }
        } catch (emailError) {
          console.error('Failed to send failure email:', emailError)
        }
      } else {
        // Will retry
        await deliveryRepo.update(delivery.id, {
          status: 'retrying',
          attempt_count: attemptCount,
          last_attempted_at: new Date(),
          response_body:
            error instanceof Error ? error.message : 'Unknown error',
        })

        console.warn(
          `Event ${eventId} attempt ${attemptCount} failed — will retry`
        )
        throw error // Re-throw so BullMQ triggers the retry
      }
    }
  }

  // All destinations delivered
  await eventRepo.update(eventId, { status: 'delivered' })
}
