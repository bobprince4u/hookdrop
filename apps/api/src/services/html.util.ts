/**
 * Escapes text before it is interpolated into an HTML email body.
 *
 * Every template in the email services took user-controlled values — display name,
 * endpoint name, destination URL, free-text feedback — and dropped them straight
 * into HTML. A name of `<img src=x onerror=...>` was rendered by the recipient's
 * mail client, and a feedback message could rewrite the whole email including the
 * links in it (H-23).
 */
export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/**
 * Escapes a value used inside an `href`.
 *
 * `escapeHtml` alone does not stop `javascript:` URLs, so anything that reaches an
 * attribute is checked for an http(s) scheme first.
 */
export const safeUrl = (value: string | undefined, fallback = '#'): string => {
  if (!value) return fallback
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    return escapeHtml(url.toString())
  } catch {
    return fallback
  }
}
