import axios from 'axios'
import crypto from 'crypto'
import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'

export class PaystackProvider implements PaymentProvider {
  name = 'paystack'

  private getSecretKey(): string {
    const key = process.env.PAYSTACK_SECRET_KEY
    if (!key) throw new Error('PAYSTACK_SECRET_KEY not set')
    return key
  }

  async initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const secretKey = this.getSecretKey()

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100,
        currency,
        metadata,
        callback_url: callbackUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
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

  verifyWebhook(
    payload: string,
    signature: string
  ): WebhookVerificationResult {
    const secretKey = process.env.PAYSTACK_SECRET_KEY || ''
    const hash = crypto
      .createHmac('sha512', secretKey)
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
