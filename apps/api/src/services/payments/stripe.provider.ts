import Stripe from 'stripe'
import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

export class StripeProvider implements PaymentProvider {
  name = 'stripe'
  // @ts-ignore
  private stripe: Stripe
  private webhookSecret: string

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      // @ts-ignore
      apiVersion: '2024-12-18.acacia',
    })
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''
  }

  async initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    // Convert NGN amount to USD cents approximately
    // In production use a real FX rate API
    const usdAmount = Math.round((amount / 1600) * 100) // 1 USD ≈ 1600 NGN

    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Hookdrop ${String(metadata.plan)} Plan`,
              description: 'Webhook relay and inspector',
            },
            unit_amount: usdAmount,
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      metadata: metadata as Record<string, string>,
      success_url: `${callbackUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
    })

    return {
      authorization_url: session.url || '',
      reference: session.id,
      provider: this.name,
    }
  }

  verifyWebhook(payload: string, signature: string): WebhookVerificationResult {
    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret
      )

      return {
        valid: true,
        event: event.type,
        data: event.data.object as Record<string, unknown>,
      }
    } catch {
      return { valid: false, event: '', data: {} }
    }
  }

  getCustomerId(data: Record<string, unknown>): string {
    return (data.customer as string) || ''
  }

  getSubscriptionId(data: Record<string, unknown>): string {
    return (data.id as string) || ''
  }
}
