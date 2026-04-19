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

export const sendSubscriptionReminderEmail = async (
  email: string,
  name: string,
  plan: string,
  daysLeft: number,
  expiresAt: Date
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: `Your Hookdropi ${plan} plan expires in ${daysLeft} days`,
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Your plan expires soon</h1>
          <p style="color: #71717a; margin-bottom: 24px;">
            Hi ${name}, your Hookdropi <strong style="color: #e4e4e7;">${plan}</strong> plan expires in <strong style="color: #f87171;">${daysLeft} days</strong> on ${new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
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
          <a href="${process.env.FRONTEND_URL}/dashboard/billing"
            style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
            Renew your plan →
          </a>
          <p style="color: #52525b; font-size: 12px; margin-top: 24px;">
            Questions? Reply to this email and we'll help you out.
          </p>
        </div>
      `,
    })
  } catch (error) {
    console.error('Subscription reminder email error:', error)
  }
}

export const sendExpiredEmail = async (
  email: string,
  name: string,
  previousPlan: string
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Your Hookdropi subscription has ended',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">Your subscription has ended</h1>
          <p style="color: #71717a; margin-bottom: 24px;">
            Hi ${name}, your Hookdropi <strong style="color: #e4e4e7;">${previousPlan}</strong> plan has expired and your account has been moved to the free tier.
          </p>
          <div style="background: #18181b; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">You are now on the free plan:</p>
            <ul style="color: #e4e4e7; font-size: 14px; padding-left: 20px; margin: 0;">
              <li style="margin-bottom: 6px;">500 events per month</li>
              <li style="margin-bottom: 6px;">24 hour event retention</li>
              <li>AI features are disabled</li>
            </ul>
          </div>
          <a href="${process.env.FRONTEND_URL}/dashboard/billing"
            style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
            Resubscribe →
          </a>
        </div>
      `,
    })
  } catch (error) {
    console.error('Expired email error:', error)
  }
}

export const sendDay1TipsEmail = async (
  email: string,
  name: string
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Getting the most out of Hookdrop',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">3 things to try today</h1>
          <p style="color: #71717a; margin-bottom: 24px;">Hi ${name}, here's how to get the most out of Hookdrop.</p>
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
          <a href="${process.env.FRONTEND_URL}/dashboard"
            style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
            Go to dashboard →
          </a>
        </div>
      `,
    })
  } catch (error) {
    console.error('Day 1 tips email error:', error)
  }
}

export const sendDay3UpgradeEmail = async (
  email: string,
  name: string
): Promise<void> => {
  try {
    await resend.emails.send({
      from: FROM,
      to: email,
      subject: 'Unlock AI features on Hookdrop',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
          <h1 style="font-size: 22px; font-weight: 600; margin-bottom: 8px;">You're missing the best part</h1>
          <p style="color: #71717a; margin-bottom: 24px;">Hi ${name}, Hookdrop's AI layer is available on paid plans. Here's what you unlock:</p>
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
          <a href="${process.env.FRONTEND_URL}/dashboard/billing"
            style="background: linear-gradient(135deg, #3B82F6, #4F46E5); color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 500; display: inline-block;">
            Upgrade to Starter — ₦7,500/mo →
          </a>
        </div>
      `,
    })
  } catch (error) {
    console.error('Day 3 upgrade email error:', error)
  }
}
