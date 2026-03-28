import { Response } from 'express'
import { AppDataSource } from '../db'
import { Destination } from '../entities/Destination'
import { Endpoint } from '../entities/Endpoint'
import { AuthRequest } from '../middleware/auth'

export const listDestinations = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const destinationRepo = AppDataSource.getRepository(Destination)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const destinations = await destinationRepo.find({
      where: { endpoint_id: id },
      order: { created_at: 'DESC' },
    })

    res.json({ destinations })
  } catch (error) {
    console.error('List destinations error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const createDestination = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const destinationRepo = AppDataSource.getRepository(Destination)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const { url, secret } = req.body

    if (!url) {
      res.status(400).json({ error: 'URL is required' })
      return
    }

    const destination = destinationRepo.create({
      endpoint_id: id,
      url,
      secret: secret || null,
      is_active: true,
    })

    const saved = await destinationRepo.save(destination)
    res.status(201).json({ destination: saved })
  } catch (error) {
    console.error('Create destination error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const deleteDestination = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const dId = req.params.dId as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const destinationRepo = AppDataSource.getRepository(Destination)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const destination = await destinationRepo.findOne({
      where: { id: dId, endpoint_id: id },
    })

    if (!destination) {
      res.status(404).json({ error: 'Destination not found' })
      return
    }

    await destinationRepo.remove(destination)
    res.json({ ok: true })
  } catch (error) {
    console.error('Delete destination error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
