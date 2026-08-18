import crypto from 'node:crypto'

/**
 * Length-safe, constant-time comparison of two hex/ASCII strings.
 *
 * `crypto.timingSafeEqual` throws when the buffers differ in length, and the
 * previous code used `!==`, which short-circuits on the first differing byte and
 * leaks the position of the mismatch (H-05, H-39).
 */
export const timingSafeCompare = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a, 'utf8')
  const bufferB = Buffer.from(b, 'utf8')

  // Compare digests of equal length so the early return does not itself leak
  // length information beyond what an attacker already controls.
  const digestA = crypto.createHash('sha256').update(bufferA).digest()
  const digestB = crypto.createHash('sha256').update(bufferB).digest()

  return crypto.timingSafeEqual(digestA, digestB)
}

export const sha256Hex = (payload: Buffer): string =>
  crypto.createHash('sha256').update(payload).digest('hex')
