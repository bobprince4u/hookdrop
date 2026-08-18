/**
 * Inbound header redaction at the write path (H-17).
 *
 * `routes/ingest.ts` stored `req.headers` verbatim on every captured event. Whatever a
 * sender put in `Authorization`, `Cookie`, or a provider signature header was therefore
 * written to Postgres in plaintext and then re-served by the events API, rendered in the
 * dashboard, and included in the prompts sent to Gemini — four surfaces, none of which the
 * sender knew about.
 *
 * This is the durable half of the fix: nothing sensitive is stored at all. The API's
 * `services/headers.util.ts` is the read-side half, and it is not redundant, because every
 * row written before this deploys keeps its plaintext values.
 *
 * A verbatim copy of the API's list, for the same reason the plan catalogue is
 * (see `plan.service.ts`) — two redaction lists that disagree would mean the write path
 * stored something the read path was still trying to hide.
 *
 * Redacting rather than dropping the key: knowing that a request carried a signature header
 * is exactly what someone debugging a webhook needs to see. The value is not.
 */

/**
 * Matched case-insensitively against the header name.
 *
 * Signature headers are included because a MAC is a credential-shaped value — it stays
 * replayable against the endpoint that trusts it for as long as the surrounding request
 * does.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  // Provider signature and shared-secret headers.
  'stripe-signature',
  'x-paystack-signature',
  'verif-hash',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-signature',
  'x-signature-sha256',
  'x-webhook-signature',
  'x-shopify-hmac-sha256',
  'x-hookdrop-signature',
])

/** Any header whose name contains one of these is treated as sensitive. */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'private-key',
  'privatekey',
]

export const REDACTED = '[redacted]'

export const isSensitiveHeader = (name: string): boolean => {
  const lower = name.toLowerCase()
  if (SENSITIVE_HEADERS.has(lower)) return true
  return SENSITIVE_FRAGMENTS.some((fragment) => lower.includes(fragment))
}

/**
 * Returns a copy with sensitive values replaced.
 *
 * Non-mutating on purpose: `req.headers` is Node's own object and Express reads from it
 * after the handler returns, so redacting in place would corrupt the live request.
 */
export const redactSensitiveHeaders = (
  headers: unknown
): Record<string, unknown> => {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return {}
  }

  const result: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    result[name] = isSensitiveHeader(name) ? REDACTED : value
  }
  return result
}
