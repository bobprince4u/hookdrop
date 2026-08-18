/**
 * Escapes text before it is interpolated into an HTML email body.
 *
 * A verbatim copy of `apps/api/src/services/html.util.ts` — see `plan.service.ts` for why
 * the copies exist and when they collapse.
 *
 * The audit recorded H-23 as complete because `apps/api`'s templates were fixed. They were.
 * These two services were never touched, and between them they send the plan-limit warning,
 * the delivery-failure alert, the expiry reminder and the onboarding sequence — so a display
 * name of `<img src=x onerror=…>` was still being rendered by the recipient's mail client,
 * and a destination URL is user-controlled text that lands in the same templates.
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
 * `escapeHtml` alone does not stop `javascript:` URLs, so anything that reaches an attribute
 * is checked for an http(s) scheme first.
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
