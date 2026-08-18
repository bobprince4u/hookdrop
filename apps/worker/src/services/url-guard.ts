import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net'
import { promises as dns } from 'node:dns'

/**
 * SSRF guard for outbound webhook delivery (H-02).
 *
 * This copy is the authoritative one. `assertPublicUrl` runs immediately before the
 * connection and returns a pinned address that the delivery processor connects to
 * directly, so there is no second name resolution between the check and the socket.
 *
 * The audit found both layers empty, each deferring to the other: the API's write-time
 * `refine` tested only `protocol`, and its comment claimed the worker was authoritative
 * while the worker contained no SSRF code at all.
 *
 * DUPLICATION: identical to `apps/api/src/services/url-guard.ts` except for this header
 * comment — deliberately so, since npm workspaces cannot import across sibling apps
 * without a shared package, and H-35 (`packages/shared`) is sequenced last so the
 * abstraction lands after behaviour is stable. `diff` between the two files is the drift
 * check; it should report only this block. **Until H-35, changes go in both.**
 */

/**
 * Ranges that must never be reached by a user-supplied destination.
 *
 * `net.BlockList` is used rather than hand-rolled CIDR arithmetic: it ships with Node,
 * handles both families, and is not a place where an off-by-one in a bit mask should be
 * introduced by hand.
 */
const buildBlockList = (): BlockList => {
  const list = new BlockList()

  // --- IPv4 -----------------------------------------------------------------
  list.addSubnet('0.0.0.0', 8, 'ipv4') // "this host on this network"
  list.addSubnet('10.0.0.0', 8, 'ipv4') // RFC1918 private
  list.addSubnet('100.64.0.0', 10, 'ipv4') // RFC6598 CGNAT
  list.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
  /**
   * Link-local, which contains 169.254.169.254 — the cloud instance metadata address
   * on AWS, GCP and Azure, and the single most valuable SSRF target in a hosted
   * deployment. `metadata.google.internal` resolves here too, so the DNS resolution
   * step below catches the hostname form without needing a name blocklist.
   */
  list.addSubnet('169.254.0.0', 16, 'ipv4')
  list.addSubnet('172.16.0.0', 12, 'ipv4') // RFC1918 private
  list.addSubnet('192.0.0.0', 24, 'ipv4') // IETF protocol assignments
  list.addSubnet('192.0.2.0', 24, 'ipv4') // TEST-NET-1
  list.addSubnet('192.88.99.0', 24, 'ipv4') // 6to4 relay anycast
  list.addSubnet('192.168.0.0', 16, 'ipv4') // RFC1918 private
  list.addSubnet('198.18.0.0', 15, 'ipv4') // benchmarking
  list.addSubnet('198.51.100.0', 24, 'ipv4') // TEST-NET-2
  list.addSubnet('203.0.113.0', 24, 'ipv4') // TEST-NET-3
  list.addSubnet('224.0.0.0', 4, 'ipv4') // multicast
  list.addSubnet('240.0.0.0', 4, 'ipv4') // reserved
  list.addAddress('255.255.255.255', 'ipv4') // broadcast

  // --- IPv6 -----------------------------------------------------------------
  list.addAddress('::', 'ipv6') // unspecified
  list.addAddress('::1', 'ipv6') // loopback
  list.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64 — can encode a private IPv4
  list.addSubnet('100::', 64, 'ipv6') // discard-only
  list.addSubnet('2001:db8::', 32, 'ipv6') // documentation
  list.addSubnet('2002::', 16, 'ipv6') // 6to4 — can encode a private IPv4
  list.addSubnet('fc00::', 7, 'ipv6') // unique local
  list.addSubnet('fe80::', 10, 'ipv6') // link-local
  list.addSubnet('ff00::', 8, 'ipv6') // multicast

  return list
}

const BLOCKED = buildBlockList()

/**
 * `::ffff:127.0.0.1` is loopback wearing an IPv6 costume. Unwrapping it and testing the
 * IPv4 rules explicitly means the v4 table cannot be bypassed by changing notation,
 * without relying on how `BlockList` chooses to treat mapped addresses.
 */
const unwrapIpv4Mapped = (address: string): string | null => {
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address)
  if (match && isIPv4(match[1])) return match[1]

  // Hex form of the same thing: ::ffff:7f00:1
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (hex) {
    const high = Number.parseInt(hex[1], 16)
    const low = Number.parseInt(hex[2], 16)
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
  }

  return null
}

/** True when the literal address is one we refuse to connect to. */
export const isBlockedAddress = (address: string): boolean => {
  if (isIPv4(address)) return BLOCKED.check(address, 'ipv4')

  if (isIPv6(address)) {
    const mapped = unwrapIpv4Mapped(address)
    if (mapped && BLOCKED.check(mapped, 'ipv4')) return true
    return BLOCKED.check(address, 'ipv6')
  }

  // Not an IP literal at all — caller resolves first, so reaching here is a bug.
  return true
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedUrlError'
  }
}

/**
 * Synchronous, DNS-free validation for use inside Zod schemas.
 *
 * Zod refinements run synchronously in the request-validation middleware, so no name
 * resolution can happen here. That is the honest boundary of this check: it rejects
 * non-HTTP schemes, embedded credentials, and addresses written as private *literals* —
 * which is what the old refinement's comment claimed to do while testing only
 * `url.protocol`, so `http://localhost/` and `http://169.254.169.254/` both passed.
 *
 * Returns null when acceptable, or the reason it is not.
 */
export const literalUrlRejectionReason = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'URL must be a valid absolute http(s) URL'
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return 'URL must use http or https'
  }

  if (url.username || url.password) {
    return 'URL must not contain credentials'
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (!hostname) return 'URL has no host'

  if (isIP(hostname)) {
    return isBlockedAddress(hostname)
      ? 'URL points at a reserved or private address'
      : null
  }

  /**
   * A small set of names is rejected outright even though the DNS check would also catch
   * them. They are the ones users hit by accident when pasting a local development URL,
   * and failing at write time with a clear message beats accepting the destination and
   * failing every delivery later.
   */
  const lowered = hostname.toLowerCase()
  const blockedNames = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'instance-data',
  ])
  if (blockedNames.has(lowered) || lowered.endsWith('.localhost')) {
    return 'URL points at a local address'
  }

  return null
}

export interface SafeTarget {
  /** The URL as parsed, unchanged. */
  url: URL
  /** Hostname from the URL, used for the `Host` header and TLS SNI. */
  hostname: string
  /** The single resolved address the request must connect to. */
  address: string
  family: 4 | 6
}

/**
 * Validates a destination URL and resolves it to one pinned address.
 *
 * The pinning is the part that closes DNS rebinding, and it is why this returns an
 * address rather than a boolean. Validating a hostname and then handing the *hostname*
 * to an HTTP client leaves a second, unchecked resolution between the check and the
 * connection: a hostname with a 0-second TTL can answer public once for the guard and
 * private once for the socket. The delivery processor connects to `address` and carries
 * `hostname` only in the `Host` header and SNI, so no second lookup exists to poison.
 *
 * Every resolved address must be public, not merely the first: a name that answers with
 * both a public and a private record would otherwise be a coin flip.
 */
export const assertPublicUrl = async (raw: string): Promise<SafeTarget> => {
  const reason = literalUrlRejectionReason(raw)
  if (reason) throw new BlockedUrlError(reason)

  const url = new URL(raw)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  if (isIP(hostname)) {
    return {
      url,
      hostname,
      address: hostname,
      family: isIPv4(hostname) ? 4 : 6,
    }
  }

  let resolved: { address: string; family: number }[]
  try {
    resolved = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new BlockedUrlError(
      `Could not resolve ${hostname}: ${error instanceof Error ? error.message : 'lookup failed'}`
    )
  }

  if (resolved.length === 0) {
    throw new BlockedUrlError(`${hostname} resolved to no addresses`)
  }

  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      // The address is named in the error because the destination owner controls it and
      // is entitled to know why their endpoint was refused. It is not secret.
      throw new BlockedUrlError(
        `${hostname} resolves to ${entry.address}, which is in a reserved or private range`
      )
    }
  }

  const chosen = resolved[0]
  return {
    url,
    hostname,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  }
}
