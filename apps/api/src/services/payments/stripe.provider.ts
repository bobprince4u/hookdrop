import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'

export class StripeProvider implements PaymentProvider {
  name = 'stripe'

  private getStripe() {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY not set')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Stripe = require('stripe')
    return new Stripe(key, { apiVersion: null })
  }

  async initializePayment(
    email: string,
    amount: number,
    _currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const stripe = this.getStripe()
    const usdAmount = Math.round((amount / 1600) * 100)

    const session = await stripe.checkout.sessions.create({
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

  verifyWebhook(
    payload: string,
    signature: string
  ): WebhookVerificationResult {
    try {
      const stripe = this.getStripe()
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ''
      const event = stripe.webhooks.constructEvent(payload, signature, webhookSecret)
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
