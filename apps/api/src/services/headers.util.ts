/**
 * Header redaction (H-17).
 *
 * Captured webhook headers are stored verbatim by the ingestion service, then re-served
 * by the events API, rendered in the dashboard, and included in AI prompts. Anything a
 * sender puts in `Authorization`, `Cookie`, or a provider signature header is therefore
 * persisted in plaintext and readable through several surfaces.
 *
 * The durable fix is to redact at the write path so nothing sensitive is stored at all,
 * and that lands with the ingestion changes. This module is the read-side counterpart,
 * and it is not redundant: rows already in the table keep their plaintext values, so a
 * *public* endpoint serving those rows needs redaction applied on the way out or the
 * write-path fix protects only events captured after it deploys.
 *
 * Redacting rather than dropping the key: knowing that a request carried a signature
 * header is exactly what someone debugging a webhook needs to see. The value is not.
 */

/**
 * Matched case-insensitively against the header name.
 *
 * Signature headers are included because the audit calls for it and because a MAC is
 * a credential-shaped value — it is replayable against the endpoint that trusts it for
 * as long as the surrounding request stays valid.
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
 * Returns a copy with sensitive values replaced. Non-mutating, so it is safe to call
 * on an entity that is about to be saved or reused.
 *
 * Tolerates non-object input because `Event.headers` is a `jsonb` column: a row written
 * before the column's type settled can hold a string, a null, or an array.
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
