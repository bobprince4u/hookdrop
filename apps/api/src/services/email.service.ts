import { Resend } from 'resend'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const resend = new Resend(process.env.RESEND_API_KEY || '')

const FROM = 'Hookdrop <onboarding@resend.dev>'

export const sendWelcomeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Welcome to Hookdrop',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Welcome to Hookdrop, ${name}</h1>
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
          <a href="${process.env.FRONTEND_URL}/dashboard"
            style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Go to dashboard →
          </a>
          <p style="color: #52525b; font-size: 12px; margin-top: 32px;">
            You're on the free plan — 500 events/month, 24hr retention.
          </p>
        </div>
      `,
    })
    console.log(`Welcome email sent to ${email}`)
  } catch (error) {
    console.error('Welcome email error:', error)
  }
}

export const sendDeliveryFailureEmail = async (
  email: string,
  name: string,
  endpointName: string,
  eventId: string,
  destinationUrl: string
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `Webhook delivery failed — ${endpointName}`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Delivery failed</h1>
          <p style="color: #71717a; margin-bottom: 24px;">
            Hi ${name}, a webhook event failed to deliver after 4 attempts and has been moved to the dead letter queue.
          </p>
          <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Endpoint</p>
            <p style="color: #e4e4e7; font-size: 14px; margin: 0 0 16px;">${endpointName}</p>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Destination</p>
            <p style="color: #e4e4e7; font-size: 14px; margin: 0 0 16px; word-break: break-all;">${destinationUrl}</p>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 6px;">Event ID</p>
            <p style="color: #e4e4e7; font-size: 13px; font-family: monospace; margin: 0;">${eventId}</p>
          </div>
          <a href="${process.env.FRONTEND_URL}/dashboard"
            style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Replay event →
          </a>
        </div>
      `,
    })
    console.log(`Failure email sent to ${email}`)
  } catch (error) {
    console.error('Failure email error:', error)
  }
}

export const sendPlanLimitWarningEmail = async (
  email: string,
  name: string,
  currentCount: number,
  limit: number
): Promise<void> => {
  try {
    const percentage = Math.round((currentCount / limit) * 100)
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `You have used ${percentage}% of your monthly events`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 24px; font-weight: 600; margin-bottom: 8px;">Approaching event limit</h1>
          <p style="color: #71717a; margin-bottom: 24px;">
            Hi ${name}, you have used ${currentCount.toLocaleString()} of your ${limit.toLocaleString()} monthly events (${percentage}%).
          </p>
          <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <div style="background: #27272a; border-radius: 4px; height: 8px; margin-bottom: 8px;">
              <div style="background: white; border-radius: 4px; height: 8px; width: ${percentage}%;"></div>
            </div>
            <p style="color: #a1a1aa; font-size: 13px; margin: 0;">
              ${limit - currentCount} events remaining this month
            </p>
          </div>
          <a href="${process.env.FRONTEND_URL}/dashboard/billing"
            style="background: white; color: black; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500;">
            Upgrade plan →
          </a>
        </div>
      `,
    })
    console.log(`Plan limit warning sent to ${email}`)
  } catch (error) {
    console.error('Plan limit warning error:', error)
  }
}
