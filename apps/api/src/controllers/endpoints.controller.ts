import { Response } from 'express'
import crypto from 'crypto'
import { AppDataSource } from '../db'
import { Endpoint } from '../entities/Endpoint'
import { User } from '../entities/User'
import { AuthRequest } from '../middleware/auth'
import type { z } from 'zod'
import type {
  createEndpointSchema,
  updateEndpointSchema,
} from '../validation/schemas'

/**
 * Endpoint CRUD.
 *
 * Three defects are closed here, all of which needed the middleware chain in
 * `routes/index.ts` to be mounted before they could be fixed in one place:
 *
 *  - `updateEndpoint` assigned `req.body.metadata` onto the entity unchecked, so the
 *    update path accepted arbitrary jsonb of arbitrary size (H-32). Fields are now
 *    assigned by name from a validated body.
 *  - `createEndpoint` enforced no cap at all while `PLANS[*].endpoints` sat unread,
 *    so the advertised 2-endpoint free tier was unlimited (H-26).
 *  - `GET /endpoints/:id` eager-loaded destinations, and `Destination.secret` had no
 *    `select: false`, so the response carried every signing key for the endpoint
 *    (H-11). The relation is kept — the dashboard reads it — because the key is now
 *    excluded at the column instead.
 */

type CreateEndpointInput = z.infer<typeof createEndpointSchema>
type UpdateEndpointInput = z.infer<typeof updateEndpointSchema>

/**
 * 16 bytes of CSPRNG output, hex-encoded.
 *
 * This is a bearer credential: whoever holds it can post events to the endpoint, so
 * it needs to be unguessable rather than merely unique.
 */
const generateToken = (): string => crypto.randomBytes(16).toString('hex')

export const listEndpoints = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const endpoints = await AppDataSource.getRepository(Endpoint).find({
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
    const { name } = req.body as CreateEndpointInput
    const limit = req.effectivePlan?.endpoints ?? null
    const userId = req.user!.id

    /**
     * The cap is enforced inside a transaction that locks the owning user row first.
     *
     * Counting and then inserting without the lock is a check-then-act race: two
     * concurrent creates both read `count = 1` against a limit of 2 and both insert,
     * leaving the user one over. Postgres cannot express "at most N rows" as a
     * constraint, so serialising the two writers on a row they both already own is
     * the cheapest correct answer — and it is a real lock, not an advisory one, so
     * the guarantee holds across replicas.
     */
    const created = await AppDataSource.transaction(async (manager) => {
      if (limit !== null) {
        await manager
          .getRepository(User)
          .createQueryBuilder('user')
          .setLock('pessimistic_write')
          .where('user.id = :userId', { userId })
          .getOne()

        const existing = await manager
          .getRepository(Endpoint)
          .count({ where: { user_id: userId } })

        if (existing >= limit) return null
      }

      const repo = manager.getRepository(Endpoint)
      return repo.save(
        repo.create({
          user_id: userId,
          name,
          public_token: generateToken(),
          is_active: true,
          metadata: {},
        })
      )
    })

    if (!created) {
      res.status(403).json({
        error: `Your plan includes ${limit} endpoint${limit === 1 ? '' : 's'}. Delete one or upgrade to add another.`,
        code: 'endpoint_limit_reached',
        limit,
        current_plan: req.effectivePlan?.id,
        upgrade_url: '/dashboard/billing',
      })
      return
    }

    res.status(201).json({ endpoint: created })
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
    const endpoint = await AppDataSource.getRepository(Endpoint).findOne({
      where: { id: req.params.id as string, user_id: req.user!.id },
      // Safe now that `Destination.secret` is `select: false`; see the header note.
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
    const repo = AppDataSource.getRepository(Endpoint)

    const endpoint = await repo.findOne({
      where: { id: req.params.id as string, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    // Assigned field by field from a validated body. `user_id`, `public_token` and
    // `id` are unreachable from here by construction, which is the point: the old
    // version's `metadata` passthrough meant the request decided what got written.
    const { name, is_active, metadata } = req.body as UpdateEndpointInput

    if (name !== undefined) endpoint.name = name
    if (is_active !== undefined) endpoint.is_active = is_active
    if (metadata !== undefined) endpoint.metadata = metadata

    res.json({ endpoint: await repo.save(endpoint) })
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
    const repo = AppDataSource.getRepository(Endpoint)

    const endpoint = await repo.findOne({
      where: { id: req.params.id as string, user_id: req.user!.id },
    })

    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    // `remove` rather than `delete` so the entity's `onDelete: 'CASCADE'` relations
    // are honoured through the same path they always were.
    await repo.remove(endpoint)
    res.json({ ok: true })
  } catch (error) {
    console.error('Delete endpoint error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
