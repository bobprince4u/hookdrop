import { Response } from 'express'
import { AuthRequest } from '../middleware/auth'
import * as apiKeyService from '../services/apiKey.service'
import { ApiKeyRequestError } from '../services/apiKey.service'
import type { CreateApiKeyInput } from '../validation/schemas'

/**
 * API-key management (H-27).
 *
 * These routes replace the settings page's "Copy API token" button, which handed out the raw
 * access JWT from `localStorage`. Every handler scopes its work to `req.user!.id`; there is no
 * path through this file that reads or writes another tenant's key.
 *
 * All three are mounted behind `denyApiKeyAuth`, so a key cannot be used to mint or revoke
 * keys. That is the point of a separate credential type: a leaked integration key must not be
 * able to extend its own foothold.
 *
 * The service is imported as a namespace because the natural handler names — `createApiKey`,
 * `listApiKeys`, `revokeApiKey` — are the service's names too, and the route table reads
 * better with the resource-suffixed convention the other controllers use.
 */

export const createApiKey = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { name, expires_in_days } = req.body as CreateApiKeyInput

    const issued = await apiKeyService.createApiKey(
      req.user!.id,
      name,
      expires_in_days
    )

    /**
     * The only response that ever contains the plaintext key. Said so in the body, because
     * the client has to store it now or not at all — no endpoint can return it again, by
     * design.
     */
    res.status(201).json({
      key: issued.key,
      warning: 'Store this key now. It cannot be retrieved again.',
      api_key: issued.record,
    })
  } catch (error) {
    if (error instanceof ApiKeyRequestError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    // Message only: a QueryFailedError carries the failing SQL and its bound parameters
    // (H-48), and one of those parameters is the hash of a live credential.
    console.error(
      'Failed to create API key:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const listApiKeys = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const keys = await apiKeyService.listApiKeys(req.user!.id)
    res.json({
      api_keys: keys,
      // Surfaced so the dashboard can disable its create button before the request fails.
      limit: apiKeyService.MAX_ACTIVE_KEYS_PER_USER,
    })
  } catch (error) {
    console.error(
      'Failed to list API keys:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const revokeApiKey = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const id = req.params.id as string

    const revoked = await apiKeyService.revokeApiKey(req.user!.id, id)
    if (!revoked) {
      // "Not yours" and "already revoked" answer identically, so the response cannot be
      // used to discover which key ids exist.
      res.status(404).json({ error: 'API key not found' })
      return
    }

    res.json({ revoked: true })
  } catch (error) {
    console.error(
      'Failed to revoke API key:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}
