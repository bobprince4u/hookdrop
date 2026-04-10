import axios from 'axios'
import crypto from 'crypto'
import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'

export class FlutterwaveProvider implements PaymentProvider {
  name = 'flutterwave'

  private getKeys() {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY
    if (!secretKey || secretKey === 'placeholder') {
      throw new Error('Flutterwave is not configured. Please add FLUTTERWAVE_SECRET_KEY to your environment variables.')
    }
    return { secretKey }
  }

  async initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const { secretKey } = this.getKeys()
    const txRef = `hookdrop-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

    const response = await axios.post(
      'https://api.flutterwave.com/v3/payments',
      {
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: callbackUrl,
        customer: { email },
        meta: metadata,
        customizations: {
          title: 'Hookdrop',
          description: `Upgrade to ${metadata.plan} plan`,
          logo: 'https://hookdropi.vercel.app/hookdroplogo.png',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      }
    )

    return {
      authorization_url: response.data.data.link,
      reference: txRef,
      provider: this.name,
    }
  }

  verifyWebhook(
    payload: string,
    signature: string
  ): WebhookVerificationResult {
    const secretHash = process.env.FLUTTERWAVE_SECRET_KEY || ''
    const hash = crypto
      .createHmac('sha256', secretHash)
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
    return (data.tx_ref as string) || ''
  }
}
