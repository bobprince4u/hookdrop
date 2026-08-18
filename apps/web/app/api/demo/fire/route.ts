import { NextResponse } from 'next/server'

/**
 * Server-side proxy for the public demo's "fire a webhook at me" button (H-24, H-48).
 *
 * It exists so the browser never has to reach the ingestion service cross-origin. Three things
 * were wrong with it.
 *
 * **The demo token was hardcoded** as `const DEMO_TOKEN = 'demo-hookdrop-live-2024'`, so the
 * value lived in git and in the deployed bundle's server chunk rather than in configuration,
 * and changing it meant a code change and a redeploy. It now comes from `DEMO_PUBLIC_TOKEN`,
 * the same variable the API service validates at boot, and a missing value is a 503 rather than
 * a request that silently posts to `/in/undefined`.
 *
 * **The ingestion URL had a hardcoded production fallback.** A misconfigured preview or local
 * environment would quietly fire demo traffic at production ingestion instead of failing.
 *
 * **The logs leaked the URL with the token in it** (`'Firing demo webhook to:',
 * '${ingestionUrl}/in/${DEMO_TOKEN}'`) on every request, and echoed the raw upstream response
 * body on failure. Both are gone: what remains logs a status code and nothing else.
 *
 * The payload is also bounded now. This is an unauthenticated endpoint that causes a webhook to
 * be delivered, so the request body is checked to be a JSON object within 16 KB — the same
 * bound `demoFireSchema` applies in `apps/api/src/validation/schemas.ts`. It is duplicated
 * rather than imported because npm workspaces cannot import across sibling apps; H-35's
 * `packages/shared` is where the two converge.
 */

/** Matches `demoFireSchema`'s cap in the API service. */
const MAX_PAYLOAD_BYTES = 16_384

/** The demo is a convenience, not a dependency — do not hold a request open for it. */
const UPSTREAM_TIMEOUT_MS = 10_000

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 })

export async function POST(request: Request) {
  const token = process.env.DEMO_PUBLIC_TOKEN
  const ingestionUrl =
    process.env.INGESTION_URL || process.env.NEXT_PUBLIC_INGESTION_URL

  if (!token || !ingestionUrl) {
    // Names the missing variable in the server log, never its value, and tells the client
    // nothing about the deployment's configuration.
    console.error(
      'Demo fire is not configured:',
      !token ? 'DEMO_PUBLIC_TOKEN is unset' : 'INGESTION_URL is unset'
    )
    return NextResponse.json(
      { error: 'The demo is not available right now' },
      { status: 503 }
    )
  }

  /**
   * Read as text first, so the size can be checked before anything parses it. `request.json()`
   * would have to buffer and parse the whole body before we could measure it.
   */
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return badRequest('Could not read the request body')
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) {
    return NextResponse.json(
      { error: 'Demo payloads are limited to 16 KB' },
      { status: 413 }
    )
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return badRequest('Body must be valid JSON')
  }

  // A JSON object specifically: an array or a bare scalar is valid JSON but not a webhook
  // payload, and `null` passes a truthiness check.
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    return badRequest('Body must be a JSON object')
  }

  try {
    const response = await fetch(
      `${ingestionUrl.replace(/\/+$/, '')}/in/${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }
    )

    if (!response.ok) {
      // Status only. The upstream body was being logged verbatim, and an ingestion error can
      // quote the request it rejected.
      console.error('Demo ingestion rejected the request:', response.status)
      return NextResponse.json(
        { error: 'The demo webhook could not be delivered' },
        { status: 502 }
      )
    }

    /**
     * 502 rather than 500 when the upstream misbehaves, so a client can tell "the demo service
     * is unhappy" from "this route is broken". A non-JSON success body is the upstream's
     * problem, not something to pass through unparsed.
     */
    try {
      return NextResponse.json(await response.json())
    } catch {
      console.error('Demo ingestion returned a non-JSON success body')
      return NextResponse.json(
        { error: 'The demo webhook could not be delivered' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error(
      'Demo fire failed to reach ingestion:',
      error instanceof Error ? error.name : 'unknown error'
    )
    return NextResponse.json(
      { error: 'Failed to reach the ingestion service' },
      { status: 502 }
    )
  }
}
