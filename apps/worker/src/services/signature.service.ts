import { createHmac } from 'node:crypto'

/**
 * Outbound delivery signing (H-11).
 *
 * `Destination.secret` is documented on the entity as "HMAC-SHA256 signing key for
 * outbound deliveries" and was never read by anything: `createHmac` did not appear
 * anywhere in `apps/worker/src`. Users configured a secret, the UI accepted it, and
 * every delivery went out unsigned — so a receiver following our own documentation had
 * no way to distinguish a relayed webhook from anything else that could POST to them.
 */

/** Header carrying the signature. Versioned so the scheme can change compatibly. */
export const SIGNATURE_HEADER = 'X-Hookdrop-Signature'
export const TIMESTAMP_HEADER = 'X-Hookdrop-Timestamp'

export interface DeliverySignature {
  timestamp: string
  signature: string
}

/**
 * Signs `timestamp.body` rather than the body alone.
 *
 * Binding the timestamp into the signed string is what lets a receiver reject replays:
 * with a detached timestamp an attacker who captured one delivery could resend it
 * forever with a fresh timestamp and an unchanged, still-valid signature.
 *
 * The body is signed as bytes, so a receiver that verifies against its own raw request
 * body gets a match regardless of key ordering or whitespace — the same property the
 * payment providers rely on, and the reason H-05 required a raw parser on the inbound
 * side.
 */
export const signDelivery = (
  secret: string,
  body: Buffer,
  timestampSeconds: number = Math.floor(Date.now() / 1000)
): DeliverySignature => {
  const timestamp = String(timestampSeconds)

  const mac = createHmac('sha256', secret)
  mac.update(timestamp)
  mac.update('.')
  mac.update(body)

  return { timestamp, signature: `v1=${mac.digest('hex')}` }
}

/**
 * Verification recipe for destination owners, kept next to the implementation so the
 * two cannot drift. Reproduced in `docs/hardening.md`.
 *
 * ```js
 * // Express, with the raw body — NOT the parsed object.
 * app.post('/hook', express.raw({ type: '*[/]*' }), (req, res) => {
 *   const timestamp = req.get('X-Hookdrop-Timestamp')
 *   const presented = req.get('X-Hookdrop-Signature')
 *
 *   // Reject anything older than five minutes to bound replay.
 *   if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
 *     return res.status(400).send('stale')
 *   }
 *
 *   const expected = 'v1=' + crypto
 *     .createHmac('sha256', process.env.HOOKDROP_SECRET)
 *     .update(timestamp + '.')
 *     .update(req.body)
 *     .digest('hex')
 *
 *   // Constant-time, and length-checked first: timingSafeEqual throws on a mismatch.
 *   const a = Buffer.from(expected)
 *   const b = Buffer.from(presented ?? '')
 *   if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
 *     return res.status(401).send('bad signature')
 *   }
 *
 *   res.sendStatus(200)
 * })
 * ```
 */
export const VERIFICATION_DOC_ANCHOR = 'docs/hardening.md#verifying-deliveries'
