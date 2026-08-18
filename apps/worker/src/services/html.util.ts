/**
 * Escapes text before it is interpolated into an HTML email body.
 *
 * A verbatim copy of `apps/api/src/services/html.util.ts` — see the API's copy for the
 * reasoning, and `apps/ingestion/src/services/plan.service.ts` for why the copies exist and
 * when they collapse.
 *
 * The audit recorded H-23 as complete because `apps/api`'s templates were fixed. They were.
 * This service was never touched, and it is the one that sends subscription reminders,
 * expiry notices, delivery-failure alerts and the onboarding sequence — seven templates,
 * every one of them interpolating a user-supplied display name into HTML unescaped.
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
