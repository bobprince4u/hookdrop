import { Resend } from 'resend'
import { env } from '../config/env'
import { escapeHtml, safeUrl } from './html.util'

/**
 * Transactional email.
 *
 * Two problems fixed here (H-23, H-31):
 *  - The sender was hardcoded to `onboarding@resend.dev`, Resend's sandbox address.
 *    It only delivers to the account owner's own mailbox, so every welcome email,
 *    failure alert and limit warning to a real user was silently dropped. The
 *    sender is now `EMAIL_FROM`, which must be a verified domain.
 *  - Recipient-controlled text was interpolated into HTML unescaped.
 *
 * Delivery failures are still swallowed on purpose: email is never allowed to fail
 * a request or a queue job. They are logged, and `EMAIL_FROM` being unset is
 * reported once at first use rather than per send.
 */

const client = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null

let warnedNoSender = false

const sender = (): string | null => {
  if (!env.EMAIL_FROM) {
    if (!warnedNoSender) {
      warnedNoSender = true
      console.warn(
        'EMAIL_FROM is not configured; transactional email is disabled. Set it to an address on a domain verified with Resend.'
      )
    }
    return null
  }
  return env.EMAIL_FROM
}

interface SendArgs {
  to: string
  subject: string
  html: string
  replyTo?: string
}

/** Subjects are headers: CR/LF in one is a header-injection primitive. */
const headerSafe = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').trim().slice(0, 200)

const send = async (args: SendArgs): Promise<void> => {
  const from = sender()
  if (!client || !from) return

  try {
    const result = await client.emails.send({
      from,
      to: args.to,
      subject: headerSafe(args.subject),
      html: args.html,
      ...(args.replyTo ? { replyTo: headerSafe(args.replyTo) } : {}),
    })
    if (result.error) {
      // Provider-side rejection (unverified domain, suppressed recipient). Log the
      // reason; never log the API key or the rendered body.
      console.error(`Email "${args.subject}" rejected: ${result.error.message}`)
    }
  } catch (error) {
    console.error(
      `Email "${args.subject}" failed:`,
      error instanceof Error ? error.message : 'unknown error'
    )
  }
}

const dashboardUrl = (path = ''): string =>
  safeUrl(`${env.FRONTEND_URL ?? ''}${path}`)

const shell = (body: string): string => `
  <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
    ${body}
  </div>
`

export const sendWelcomeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Welcome to Hookdrop',
    html: shell(`
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
        Go to dashboard
      </a>
      <p style="color: #52525b; font-size: 12px; margin-top: 32px;">
        You're on the free plan — 500 events/month, 24hr retention.
      </p>
    `),
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
    subject: `Webhook delivery failed — ${endpointName.slice(0, 80)}`,
    html: shell(`
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
        Replay event
      </a>
    `),
  })
}

export const sendPlanLimitWarningEmail = async (
  email: string,
  name: string,
  currentCount: number,
  limit: number
): Promise<void> => {
  const percentage = limit > 0 ? Math.round((currentCount / limit) * 100) : 0
  // Clamped so the inline bar width stays valid CSS even if the count exceeds the limit.
  const barWidth = Math.min(100, Math.max(0, percentage))

  await send({
    to: email,
    subject: `You have used ${percentage}% of your monthly events`,
    html: shell(`
      <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Approaching event limit</h1>
      <p style="color: #71717a; margin-bottom: 24px;">
        Hi ${escapeHtml(name)}, you have used ${currentCount.toLocaleString()} of your ${limit.toLocaleString()} monthly events (${percentage}%).
      </p>
      <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <div style="background: #27272a; border-radius: 4px; height: 8px; margin-bottom: 8px;">
          <div style="background: white; border-radius: 4px; height: 8px; width: ${barWidth}%;"></div>
        </div>
        <p style="color: #a1a1aa; font-size: 13px; margin: 0;">
          ${Math.max(0, limit - currentCount).toLocaleString()} events remaining this month
        </p>
      </div>
      <a href="${dashboardUrl('/dashboard/billing')}"
        style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
        Upgrade plan
      </a>
    `),
  })
}

export const sendWelcomeSequence = async (
  email: string,
  name: string
): Promise<void> => {
  const { emailQueue } = await import('../queue')

  await emailQueue.add(
    'day1-tips',
    { email, name },
    { delay: 24 * 60 * 60 * 1000 }
  )

  await emailQueue.add(
    'day3-upgrade',
    { email, name },
    { delay: 3 * 24 * 60 * 60 * 1000 }
  )
}

export const sendDay1TipsEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Getting the most out of Hookdrop',
    html: shell(`
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
        style="background: #4F46E5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
        Go to dashboard
      </a>
    `),
  })
}

export const sendDay3UpgradeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  await send({
    to: email,
    subject: 'Unlock AI features on Hookdrop',
    html: shell(`
      <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">You're missing the best part</h1>
      <p style="color: #71717a; margin-bottom: 24px;">Hi ${escapeHtml(name)}, Hookdrop's AI layer is available on paid plans. Here's what you unlock:</p>
      <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
        <div style="margin-bottom: 12px;">
          <p style="color: white; font-size: 14px; margin: 0 0 2px;">Plain English explanation</p>
          <p style="color: #a1a1aa; font-size: 12px; margin: 0;">AI reads every payload and tells you what happened in plain English.</p>
        </div>
        <div style="margin-bottom: 12px;">
          <p style="color: white; font-size: 14px; margin: 0 0 2px;">Handler code generation</p>
          <p style="color: #a1a1aa; font-size: 12px; margin: 0;">Get complete TypeScript, JavaScript, Python, or Go handler code written for you.</p>
        </div>
        <div>
          <p style="color: white; font-size: 14px; margin: 0 0 2px;">Failure diagnosis</p>
          <p style="color: #a1a1aa; font-size: 12px; margin: 0;">When delivery fails, AI tells you exactly why and how to fix it.</p>
        </div>
      </div>
      <a href="${dashboardUrl('/dashboard/billing')}"
        style="background: #4F46E5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
        Upgrade to Starter — &#8358;7,500/mo
      </a>
    `),
  })
}

/**
 * Feedback relay.
 *
 * The call site passed `req.user.id` where `userName` was expected, so every
 * feedback email was subject-lined with a uuid (H-23). The recipient is now
 * `ADMIN_EMAIL` with no hardcoded personal fallback — if it is unset, the send is
 * skipped and the caller is told, rather than mailing a developer's inbox.
 */
export const sendFeedbackEmail = async (
  userEmail: string,
  userName: string,
  type: string,
  message: string
): Promise<boolean> => {
  const recipient = env.ADMIN_EMAIL
  if (!recipient) {
    console.warn('ADMIN_EMAIL is not configured; feedback email not sent')
    return false
  }

  await send({
    to: recipient,
    subject: `[${escapeHtml(type).toUpperCase()}] Feedback from ${userName.slice(0, 60)}`,
    replyTo: userEmail,
    html: shell(`
      <h1 style="font-size: 20px; font-weight: 600; margin-bottom: 8px;">
        New ${escapeHtml(type)} feedback
      </h1>
      <p style="color: #71717a; margin-bottom: 16px;">
        From: <strong style="color: #e4e4e7;">${escapeHtml(userName)}</strong> (${escapeHtml(userEmail)})
      </p>
      <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 16px;">
        <p style="color: #e4e4e7; font-size: 14px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${escapeHtml(message)}</p>
      </div>
      <p style="color: #52525b; font-size: 12px;">
        Reply to this email to respond directly to the user.
      </p>
    `),
  })

  return true
}
