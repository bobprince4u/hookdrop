import axios from 'axios'
import crypto from 'node:crypto'
import {
  PaymentProvider,
  InitializePaymentResult,
  TransactionConfirmation,
  WebhookVerificationResult,
} from './provider.interface'
import { timingSafeCompare } from './crypto.util'
import { env } from '../../config/env'

export class PaystackProvider implements PaymentProvider {
  name = 'paystack'

  private getSecretKey(): string {
    const key = env.PAYSTACK_SECRET_KEY
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
        // Paystack charges in the minor unit; the catalogue stores naira.
        amount: Math.round(amount * 100),
        currency,
        metadata,
        callback_url: callbackUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    )

    return {
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
      provider: this.name,
    }
  }

  /**
   * Paystack signs the raw request body with HMAC-SHA512 keyed by the secret key.
   * Verification therefore has to run over the received bytes, not a re-encoded
   * copy of the parsed object (H-05).
   */
  verifyWebhook(payload: Buffer, signature: string): WebhookVerificationResult {
    const secretKey = env.PAYSTACK_SECRET_KEY
    if (!secretKey) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'PAYSTACK_SECRET_KEY is not configured',
      }
    }
    if (!signature) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'Missing x-paystack-signature header',
      }
    }

    const expected = crypto
      .createHmac('sha512', secretKey)
      .update(payload)
      .digest('hex')

    if (!timingSafeCompare(expected, signature)) {
      return { valid: false, event: '', data: {}, reason: 'Signature mismatch' }
    }

    let parsed: { event?: string; data?: Record<string, unknown> }
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'Signature valid but body is not JSON',
      }
    }

    const data = parsed.data ?? {}
    const amountMinor = typeof data.amount === 'number' ? data.amount : undefined

    return {
      valid: true,
      event: parsed.event ?? '',
      data,
      reference: typeof data.reference === 'string' ? data.reference : undefined,
      // Paystack reports kobo.
      amountMajor: amountMinor === undefined ? undefined : amountMinor / 100,
      currency: typeof data.currency === 'string' ? data.currency : undefined,
    }
  }

  /**
   * Authoritative re-read of the transaction. Paystack's signature already binds
   * the body, so this is defence in depth rather than the primary control — but it
   * is what catches a webhook whose signature is valid and whose amount was
   * tampered with before signing (i.e. a compromised key) (H-06).
   */
  async confirmTransaction(
    data: Record<string, unknown>
  ): Promise<TransactionConfirmation> {
    const reference = data.reference
    if (typeof reference !== 'string' || reference.length === 0) {
      return { status: 'unknown', reason: 'Webhook contained no reference' }
    }

    try {
      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          headers: { Authorization: `Bearer ${this.getSecretKey()}` },
          timeout: 15_000,
        }
      )

      const verified = response.data?.data as Record<string, unknown> | undefined
      if (!verified) {
        return { status: 'unknown', reason: 'Verification response had no data' }
      }

      return {
        status: verified.status === 'success' ? 'success' : 'failed',
        amountMajor:
          typeof verified.amount === 'number' ? verified.amount / 100 : undefined,
        currency:
          typeof verified.currency === 'string' ? verified.currency : undefined,
        metadata: (verified.metadata as Record<string, unknown>) ?? undefined,
      }
    } catch (error) {
      return {
        status: 'unknown',
        reason: error instanceof Error ? error.message : 'Verification failed',
      }
    }
  }

  getCustomerId(data: Record<string, unknown>): string {
    const customer = data.customer as Record<string, unknown> | undefined
    return (customer?.email as string) || ''
  }

  getSubscriptionId(data: Record<string, unknown>): string {
    return (data.reference as string) || ''
  }

  /**
   * Paystack echoes the reference we supplied at initialization, so the intent row is
   * found under that same value.
   */
  getIntentReferences(data: Record<string, unknown>): string[] {
    return typeof data.reference === 'string' && data.reference.length > 0
      ? [data.reference]
      : []
  }
}
