import { Response } from 'express'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { AuthRequest } from '../middleware/auth'
import crypto from 'crypto'

const generateToken = (): string => {
  return crypto.randomBytes(16).toString('hex')
}

export const listEndpoints = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoints = await endpointRepo.find({
      where: { user_id: req.user!.id },
      order: { created_at: 'DESC' },
    })
    res.json({ endpoints })
  } catch (error) {
    console.error('List endpoints error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const createEndpoint = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { name } = req.body

    if (!name) {
      res.status(400).json({ error: 'Name is required' })
      return
    }

    const endpointRepo = AppDataSource.getRepository(Endpoint)

    const endpoint = endpointRepo.create({
      user_id: req.user!.id,
      name,
      public_token: generateToken(),
      is_active: true,
      metadata: {},
    })

    const saved = await endpointRepo.save(endpoint)
    res.status(201).json({ endpoint: saved })
  } catch (error) {
    console.error('Create endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const getEndpoint = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
      relations: ['destinations'],
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    res.json({ endpoint })
  } catch (error) {
    console.error('Get endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const updateEndpoint = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const { name, is_active, metadata } = req.body

    if (name !== undefined) endpoint.name = name
    if (is_active !== undefined) endpoint.is_active = is_active
    if (metadata !== undefined) endpoint.metadata = metadata

    const updated = await endpointRepo.save(endpoint)
    res.json({ endpoint: updated })
  } catch (error) {
    console.error('Update endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const deleteEndpoint = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string
    const endpointRepo = AppDataSource.getRepository(Endpoint)

    const endpoint = await endpointRepo.findOne({
      where: { id, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    await endpointRepo.remove(endpoint)
    res.json({ ok: true })
  } catch (error) {
    console.error('Delete endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
