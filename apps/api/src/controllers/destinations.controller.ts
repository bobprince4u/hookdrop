import { Response } from 'express'
import { AppDataSource } from '../db'
import { Destination } from '../entities/Destination'
import { Endpoint } from '../entities/Endpoint'
import { AuthRequest } from '../middleware/auth'
import { assertPublicUrl, BlockedUrlError } from '../services/url-guard'
import type { z } from 'zod'
import type { createDestinationSchema } from '../validation/schemas'

/**
 * Destination CRUD.
 *
 * Two findings converge on this file:
 *
 *  - H-11. All three handlers returned `Destination` rows verbatim, so the outbound
 *    HMAC signing key was in the list response, the create response, and — through
 *    `relations: ['destinations']` — in `GET /endpoints/:id`. The column is now
 *    `select: false`, so it is absent by default; these handlers additionally project
 *    an explicit field list, so the shape is decided here rather than by the entity.
 *  - H-02. A destination URL was stored with no validation beyond truthiness, so
 *    `http://169.254.169.254/latest/meta-data/` was an accepted destination and the
 *    worker would dutifully POST captured payloads to it.
 *
 * The write-time check is deliberately not the control: DNS can be repointed after a
 * destination is saved. `assertPublicUrl` runs again in the worker immediately before
 * each connection, and per redirect hop. Checking here as well is what gives the user
 * an immediate, specific error instead of silent delivery failures later.
 */

type CreateDestinationInput = z.infer<typeof createDestinationSchema>

/**
 * Fields safe to return. Enumerated rather than delete-listed, because the failure
 * mode of a delete-list is that a column added later is exposed by default.
 */
const PUBLIC_FIELDS = {
  id: true,
  endpoint_id: true,
  url: true,
  is_active: true,
  created_at: true,
} as const

/** Proves the caller owns the endpoint before anything else touches it. */
const findOwnedEndpoint = async (
  req: AuthRequest
): Promise<Endpoint | null> =>
  AppDataSource.getRepository(Endpoint).findOne({
    where: { id: req.params.id as string, user_id: req.user!.id },
    select: { id: true },
  })

export const listDestinations = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const endpoint = await findOwnedEndpoint(req)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const destinations = await AppDataSource.getRepository(Destination).find({
      where: { endpoint_id: endpoint.id },
      select: PUBLIC_FIELDS,
      order: { created_at: 'DESC' },
    })

    /**
     * `has_secret` replaces the leaked value. The dashboard needs to show whether
     * signing is configured; it has never needed the key itself, and returning a
     * boolean is the whole of that requirement.
     */
    const withSecretFlag = await AppDataSource.getRepository(Destination)
      .createQueryBuilder('destination')
      .select('destination.id', 'id')
      .addSelect('destination.secret IS NOT NULL', 'has_secret')
      .where('destination.endpoint_id = :endpointId', {
        endpointId: endpoint.id,
      })
      .getRawMany<{ id: string; has_secret: boolean }>()

    const flags = new Map(withSecretFlag.map((row) => [row.id, row.has_secret]))

    res.json({
      destinations: destinations.map((destination) => ({
        ...destination,
        has_secret: flags.get(destination.id) ?? false,
      })),
    })
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
    const endpoint = await findOwnedEndpoint(req)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const { url, secret } = req.body as CreateDestinationInput

    try {
      await assertPublicUrl(url)
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        res.status(400).json({ error: error.message, code: 'url_not_allowed' })
        return
      }
      throw error
    }

    const repo = AppDataSource.getRepository(Destination)
    const saved = await repo.save(
      repo.create({
        endpoint_id: endpoint.id,
        url,
        secret: secret ?? null,
        is_active: true,
      })
    )

    /**
     * Projected explicitly. `repo.save` returns the entity it was handed, which still
     * holds the `secret` that was just assigned — `select: false` governs reads from
     * the database, not an object already in memory. Returning `saved` directly would
     * therefore have leaked the key on create even with the column excluded, which is
     * exactly the kind of near-miss the enumerated field list exists to prevent.
     */
    res.status(201).json({
      destination: {
        id: saved.id,
        endpoint_id: saved.endpoint_id,
        url: saved.url,
        is_active: saved.is_active,
        created_at: saved.created_at,
        has_secret: saved.secret != null,
      },
    })
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
    const endpoint = await findOwnedEndpoint(req)
    if (!endpoint) {
      res.status(404).json({ error: 'Endpoint not found' })
      return
    }

    const repo = AppDataSource.getRepository(Destination)

    // Scoped by `endpoint_id` as well as `id`, so a destination id belonging to
    // another tenant is a 404 rather than a successful delete.
    const destination = await repo.findOne({
      where: { id: req.params.dId as string, endpoint_id: endpoint.id },
      select: { id: true },
    })

    if (!destination) {
      res.status(404).json({ error: 'Destination not found' })
      return
    }

    await repo.delete({ id: destination.id, endpoint_id: endpoint.id })
    res.json({ ok: true })
  } catch (error) {
    console.error('Delete destination error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
