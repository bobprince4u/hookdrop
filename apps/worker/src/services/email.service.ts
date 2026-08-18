import { Resend } from 'resend'
import { env, emailFrom, frontendUrl } from '../config/env'
import { escapeHtml, safeUrl } from './html.util'

/**
 * Transactional email for the worker service.
 *
 * This is the module that sends subscription reminders, expiry notices, delivery-failure
 * alerts and the onboarding sequence — so it is the one that reaches paying customers most
 * often, and it was the least remediated of the three copies.
 *
 * - **H-23.** All seven templates interpolated a user-supplied display name into HTML
 *   unescaped, and the failure alert did the same with a user-supplied destination URL. The
 *   audit recorded H-23 as closed on the strength of `apps/api`'s templates; this file was
 *   never touched.
 * - **H-31.** The sender was hardcoded to Resend's sandbox address, already corrected to
 *   `emailFrom()`. What remained was `new Resend(env.RESEND_API_KEY ?? '')`, which builds a
 *   client that fails at the provider on every send instead of reporting once that email is
 *   not configured.
 * - **H-48.** Recipient addresses were logged on every successful send.
 *
 * Failures stay swallowed: email must never fail a queue job or abort a scheduler run.
 */

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

let warnedNoClient = false

const clientOrNull = (): Resend | null => {
  if (!client && !warnedNoClient) {
    warnedNoClient = true
    console.warn(
      'RESEND_API_KEY is not configured; transactional email from the worker service is disabled.'
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
      // The provider's reason, never the recipient or the rendered body.
      console.error(`Email "${args.subject}" rejected: ${result.error.message}`)
    }
  } catch (error) {
    console.error(
      `Email "${args.subject}" failed:`,
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

/** Config-derived, but passed through `safeUrl` so a misconfigured value cannot reach an href. */
const dashboardUrl = (path = ''): string => safeUrl(`${frontendUrl()}${path}`)

/**
 * Dates in emails are rendered in UTC.
 *
 * `toLocaleDateString` with no `timeZone` formats in the *server's* zone, so the reminder
 * email could name a different calendar day than the UTC-bounded query that selected the
 * user — telling someone their plan expires on the 8th while the scheduler downgraded them
 * on the 7th.
 */
const formatExpiry = (value: Date | string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'soon'
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

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
  // Clamped: a cached usage counter can briefly exceed the limit, and an unclamped
  // percentage renders a progress bar wider than its container and a negative remainder.
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

export const sendSubscriptionReminderEmail = async (
  email: string,
  name: string,
  plan: string,
  daysLeft: number,
  expiresAt: Date
): Promise<void> => {
  await send({
    to: email,
    subject: `Your Hookdropi ${plan} plan expires in ${daysLeft} days`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Your plan expires soon</h1>
        <p style="color: #71717a; margin-bottom: 24px;">
          Hi ${escapeHtml(name)}, your Hookdropi <strong style="color: #e4e4e7;">${escapeHtml(plan)}</strong> plan expires in <strong style="color: #f87171;">${daysLeft} days</strong> on ${escapeHtml(formatExpiry(expiresAt))}.
        </p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">After expiry you will lose:</p>
          <ul style="color: #e4e4e7; font-size: 14px; padding-left: 20px; margin: 0;">
            <li style="margin-bottom: 6px;">AI payload explanation and code generation</li>
            <li style="margin-bottom: 6px;">Extended event retention</li>
            <li style="margin-bottom: 6px;">Higher event limits</li>
            <li>Your plan will revert to the free tier (500 events/month)</li>
          </ul>
        </div>
        <a href="${dashboardUrl('/dashboard/billing')}"
          style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
          Renew your plan →
        </a>
        <p style="color: #52525b; font-size: 12px; margin-top: 24px;">
          Questions? Reply to this email and we'll help you out.
        </p>
      </div>
    `,
  })
}

export const sendExpiredEmail = async (
  email: string,
  name: string,
  previousPlan: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Your Hookdropi subscription has ended',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Your subscription has ended</h1>
        <p style="color: #71717a; margin-bottom: 24px;">
          Hi ${escapeHtml(name)}, your Hookdropi <strong style="color: #e4e4e7;">${escapeHtml(previousPlan)}</strong> plan has expired and your account has been moved to the free tier.
        </p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">You are now on the free plan:</p>
          <ul style="color: #e4e4e7; font-size: 14px; padding-left: 20px; margin: 0;">
            <li style="margin-bottom: 6px;">500 events per month</li>
            <li style="margin-bottom: 6px;">24 hour event retention</li>
            <li>AI features are disabled</li>
          </ul>
        </div>
        <a href="${dashboardUrl('/dashboard/billing')}"
          style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
          Resubscribe →
        </a>
      </div>
    `,
  })
}

export const sendDay1TipsEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Getting the most out of Hookdrop',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">3 things to try today</h1>
        <p style="color: #71717a; margin-bottom: 24px;">Hi ${escapeHtml(name)}, here's how to get the most out of Hookdrop.</p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <div style="margin-bottom: 16px;">
            <p style="color: white; font-size: 14px; font-weight: 500; margin: 0 0 4px;">1. Create your first endpoint</p>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0;">Go to your dashboard and create an endpoint. Copy the capture URL and point any webhook provider at it.</p>
          </div>
          <div style="margin-bottom: 16px;">
            <p style="color: white; font-size: 14px; font-weight: 500; margin: 0 0 4px;">2. Send a test webhook</p>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0;">Use curl or your provider's test feature. Watch it appear on your dashboard in real time.</p>
          </div>
          <div>
            <p style="color: white; font-size: 14px; font-weight: 500; margin: 0 0 4px;">3. Try the replay button</p>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0;">Click any event and hit Replay. It re-delivers to all your destinations instantly.</p>
          </div>
        </div>
        <a href="${dashboardUrl('/dashboard')}"
          style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
          Go to dashboard →
        </a>
      </div>
    `,
  })
}

export const sendDay3UpgradeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Unlock AI features on Hookdrop',
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">You're missing the best part</h1>
        <p style="color: #71717a; margin-bottom: 24px;">Hi ${escapeHtml(name)}, Hookdrop's AI layer is available on paid plans. Here's what you unlock:</p>
        <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
          <div style="margin-bottom: 12px;">
            <p style="color: white; font-size: 14px; margin: 0 0 2px;">✦ Plain English explanation</p>
            <p style="color: #a1a1aa; font-size: 12px; margin: 0;">AI reads every payload and tells you what happened.</p>
          </div>
          <div style="margin-bottom: 12px;">
            <p style="color: white; font-size: 14px; margin: 0 0 2px;">✦ Handler code generation</p>
            <p style="color: #a1a1aa; font-size: 12px; margin: 0;">Complete TypeScript, JavaScript, Python, or Go handler code written for you.</p>
          </div>
          <div>
            <p style="color: white; font-size: 14px; margin: 0 0 2px;">✦ Failure diagnosis</p>
            <p style="color: #a1a1aa; font-size: 12px; margin: 0;">AI tells you exactly why delivery failed and how to fix it.</p>
          </div>
        </div>
        <a href="${dashboardUrl('/dashboard/billing')}"
          style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
          Upgrade to Starter — ₦7,500/mo →
        </a>
      </div>
    `,
  })
}
