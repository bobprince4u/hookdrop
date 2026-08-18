import { Resend } from 'resend'
import { env, emailFrom, frontendUrl } from '../config/env'
import { escapeHtml, safeUrl } from './html.util'

/**
 * Transactional email for the ingestion service.
 *
 * Three defects, all of them in the mechanics rather than the templates:
 *
 * - **H-23.** Every template interpolated a user-supplied display name — and, in the
 *   failure alert, a user-supplied destination URL — straight into HTML. The audit recorded
 *   H-23 as closed because `apps/api`'s templates were escaped; this copy was not.
 * - **H-31.** The sender was hardcoded to `onboarding@resend.dev`, already fixed to
 *   `emailFrom()`. What remained was `new Resend(env.RESEND_API_KEY ?? '')`: with no key
 *   configured that constructs a client whose every send fails at the provider, rather than
 *   a service that reports once that email is switched off.
 * - **H-48.** Each function logged the recipient's address on success, so an ordinary
 *   `docker logs` accumulated a list of customer email addresses.
 *
 * Send failures stay swallowed on purpose: email must never fail an inbound webhook.
 */

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

let warnedNoClient = false

const clientOrNull = (): Resend | null => {
  if (!client && !warnedNoClient) {
    warnedNoClient = true
    console.warn(
      'RESEND_API_KEY is not configured; transactional email from the ingestion service is disabled.'
    )
  }
  return client
}

/** Subjects are headers: CR/LF in one is a header-injection primitive. */
const headerSafe = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)

const send = async (args: {
  to: string
  subject: string
  html: string
}): Promise<void> => {
  const resend = clientOrNull()
  if (!resend) return

  try {
    const result = await resend.emails.send({
      from: emailFrom(),
      to: args.to,
      subject: headerSafe(args.subject),
      html: args.html,
    })
    if (result.error) {
      // Provider-side rejection (unverified domain, suppressed recipient). The reason, never
      // the recipient or the rendered body.
      console.error(`Email "${args.subject}" rejected: ${result.error.message}`)
    }
  } catch (error) {
    console.error(
      `Email "${args.subject}" failed:`,
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

/**
 * Base URL for links in templates. Config-derived rather than user input, but passed through
 * `safeUrl` anyway so a misconfigured `FRONTEND_URL` cannot put a `javascript:` scheme into
 * an `href`.
 */
const dashboardUrl = (path = ''): string => safeUrl(`${frontendUrl()}${path}`)

export const sendWelcomeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Welcome to Hookdrop',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Welcome to Hookdrop, ${escapeHtml(name)}</h1>
        <p style="color: #71717a; margin-bottom: 24px;">
          Your account is ready. You can now capture, inspect, and replay webhooks from any provider.
        </p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">Get started in 2 minutes:</p>
          <ol style="color: #e4e4e7; font-size: 14px; padding-left: 20px; margin: 0;">
            <li style="margin-bottom: 6px;">Create an endpoint in your dashboard</li>
            <li style="margin-bottom: 6px;">Copy your capture URL</li>
            <li style="margin-bottom: 6px;">Point your webhook provider at it</li>
            <li>Watch events arrive in real time</li>
          </ol>
        </div>
        <a href="${dashboardUrl('/dashboard')}"
          style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
          Go to dashboard →
        </a>
        <p style="color: #52525b; font-size: 12px; margin-top: 32px;">
          You're on the free plan — 500 events/month, 24hr retention.
        </p>
      </div>
    `,
  })
}

export const sendDeliveryFailureEmail = async (
  email: string,
  name: string,
  endpointName: string,
  eventId: string,
  destinationUrl: string
): Promise<void> => {
  await send({
    to: email,
    subject: `Webhook delivery failed — ${endpointName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Delivery failed</h1>
        <p style="color: #71717a; margin-bottom: 24px;">
          Hi ${escapeHtml(name)}, a webhook event failed to deliver after 4 attempts and has been moved to the dead letter queue.
        </p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Endpoint</p>
          <p style="color: #e4e4e7; font-size: 14px; margin: 0 0 16px;">${escapeHtml(endpointName)}</p>
          <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Destination</p>
          <p style="color: #e4e4e7; font-size: 14px; margin: 0 0 16px; word-break: break-all;">${escapeHtml(destinationUrl)}</p>
          <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Event ID</p>
          <p style="color: #e4e4e7; font-size: 13px; font-family: monospace; margin: 0;">${escapeHtml(eventId)}</p>
        </div>
        <a href="${dashboardUrl('/dashboard')}"
          style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
          Replay event →
        </a>
      </div>
    `,
  })
}

export const sendPlanLimitWarningEmail = async (
  email: string,
  name: string,
  currentCount: number,
  limit: number
): Promise<void> => {
  /**
   * Clamped. `currentCount` comes from a cached usage counter that can briefly exceed the
   * limit under concurrency, and an unclamped percentage renders as a progress bar wider
   * than its container and a negative "events remaining".
   */
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((currentCount / Math.max(1, limit)) * 100))
  )
  const remaining = Math.max(0, limit - currentCount)

  await send({
    to: email,
    subject: `You have used ${percentage}% of your monthly events`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Approaching event limit</h1>
        <p style="color: #71717a; margin-bottom: 24px;">
          Hi ${escapeHtml(name)}, you have used ${currentCount.toLocaleString()} of your ${limit.toLocaleString()} monthly events (${percentage}%).
        </p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <div style="background: #27272a; border-radius: 4px; height: 8px; margin-bottom: 8px;">
            <div style="background: white; border-radius: 4px; height: 8px; width: ${percentage}%;"></div>
          </div>
          <p style="color: #a1a1aa; font-size: 13px; margin: 0;">
            ${remaining.toLocaleString()} events remaining this month
          </p>
        </div>
        <a href="${dashboardUrl('/dashboard/billing')}"
          style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
          Upgrade plan →
        </a>
      </div>
    `,
  })
}
