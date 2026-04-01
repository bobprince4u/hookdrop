import axios from 'axios'
import crypto from 'crypto'
import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

export class PaystackProvider implements PaymentProvider {
  name = 'paystack'
  private secretKey: string

  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY || ''
  }

  async initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100, // Paystack uses kobo
        currency,
        metadata,
        callback_url: callbackUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return {
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
      provider: this.name,
    }
  }

  verifyWebhook(payload: string, signature: string): WebhookVerificationResult {
    const hash = crypto
      .createHmac('sha512', this.secretKey)
      .update(payload)
      .digest('hex')

    if (hash !== signature) {
      return { valid: false, event: '', data: {} }
    }

    const parsed = JSON.parse(payload)
    return {
      valid: true,
      event: parsed.event,
      data: parsed.data,
    }
  }

  getCustomerId(data: Record<string, unknown>): string {
    const customer = data.customer as Record<string, unknown>
    return (customer?.email as string) || ''
  }

  getSubscriptionId(data: Record<string, unknown>): string {
    return (data.reference as string) || ''
  }
}
