import Stripe from 'stripe'
import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'
import { env } from '../../config/env'

/**
 * Stripe integration.
 *
 * Three defects fixed here (H-39):
 *  - `require('stripe')` inside a CommonJS-compiled TS module defeated the SDK's
 *    types, so every call site was implicitly `any`.
 *  - `apiVersion: null` is not a valid pinned version; omitting it lets the SDK
 *    use the version it was built against, which is the supported behaviour.
 *  - The NGN→USD conversion divided by a literal `1600`. The rate is now explicit
 *    configuration (`NGN_PER_USD`), so it can be corrected without a code change
 *    and is visible in the payments ledger.
 */
export class StripeProvider implements PaymentProvider {
  name = 'stripe'

  private client: Stripe | null = null

  private getStripe(): Stripe {
    const key = env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY not set')
    // Reuse the client: constructing one per call discards Stripe's connection pool.
    if (!this.client) {
      this.client = new Stripe(key)
    }
    return this.client
  }

  /** Naira price converted to whole cents at the configured rate. */
  private toUsdCents(amountNgn: number): number {
    const cents = Math.round((amountNgn / env.NGN_PER_USD) * 100)
    // Stripe rejects sub-cent and zero-amount recurring prices outright.
    return Math.max(cents, 1)
  }

  async initializePayment(
    email: string,
    amount: number,
    _currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const stripe = this.getStripe()

    const session = await stripe.checkout.sessions.create({
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
            unit_amount: this.toUsdCents(amount),
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      // Stripe metadata values must be strings.
      metadata: Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [key, String(value)])
      ),
      success_url: `${callbackUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.FRONTEND_URL ?? ''}/dashboard/billing`,
    })

    return {
      authorization_url: session.url ?? '',
      reference: session.id,
      provider: this.name,
    }
  }

  /**
   * `constructEvent` requires the raw request body. It was previously handed a
   * re-serialised object, which guaranteed a signature mismatch (H-05).
   */
  verifyWebhook(payload: Buffer, signature: string): WebhookVerificationResult {
    const webhookSecret = env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'STRIPE_WEBHOOK_SECRET is not configured',
      }
    }
    if (!signature) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'Missing stripe-signature header',
      }
    }

    try {
      const event = this.getStripe().webhooks.constructEvent(
        payload,
        signature,
        webhookSecret
      )
      const object = event.data.object as unknown as Record<string, unknown>

      return {
        valid: true,
        event: event.type,
        data: object,
        // Event id, not object id: it is unique per delivery and is what makes
        // replay detection correct for Stripe.
        reference: event.id,
        amountMajor: this.extractAmountMajor(object),
        currency:
          typeof object.currency === 'string'
            ? object.currency.toUpperCase()
            : undefined,
      }
    } catch (error) {
      return {
        valid: false,
        event: '',
        data: {},
        reason:
          error instanceof Error ? error.message : 'Signature verification failed',
      }
    }
  }

  /** Checkout sessions and invoices report cents under different field names. */
  private extractAmountMajor(
    object: Record<string, unknown>
  ): number | undefined {
    const candidates = [
      object.amount_total,
      object.amount_paid,
      object.amount_received,
      object.amount,
    ]
    const cents = candidates.find((value) => typeof value === 'number')
    return typeof cents === 'number' ? cents / 100 : undefined
  }

  getCustomerId(data: Record<string, unknown>): string {
    return typeof data.customer === 'string' ? data.customer : ''
  }

  getSubscriptionId(data: Record<string, unknown>): string {
    if (typeof data.subscription === 'string') return data.subscription
    return typeof data.id === 'string' ? data.id : ''
  }
}
