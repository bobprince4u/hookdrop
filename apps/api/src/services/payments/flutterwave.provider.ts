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

export class FlutterwaveProvider implements PaymentProvider {
  name = 'flutterwave'

  private getSecretKey(): string {
    const secretKey = env.FLUTTERWAVE_SECRET_KEY
    if (!secretKey || secretKey === 'placeholder') {
      throw new Error(
        'Flutterwave is not configured. Please add FLUTTERWAVE_SECRET_KEY to your environment variables.'
      )
    }
    return secretKey
  }

  async initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult> {
    const secretKey = this.getSecretKey()
    const txRef = `hookdrop-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

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
          description: `Upgrade to ${String(metadata.plan)} plan`,
          logo: `${env.FRONTEND_URL ?? ''}/hookdroplogo.png`,
        },
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
      authorization_url: response.data.data.link,
      reference: txRef,
      provider: this.name,
    }
  }

  /**
   * Flutterwave does not sign the payload at all. It sends the shared secret you
   * configured in the dashboard, verbatim, in the `verif-hash` header.
   *
   * The previous implementation computed HMAC-SHA256 of the body keyed by
   * `FLUTTERWAVE_SECRET_KEY` and compared that to the header, which could never
   * match — so either every webhook was rejected, or (had the comparison been
   * inverted) any payload would have been accepted (H-05).
   *
   * Because the body is unauthenticated even when the header is correct, a valid
   * header only establishes "this came from someone who knows the shared secret".
   * `confirmTransaction` re-reads the transaction from Flutterwave before anything
   * is granted (H-06).
   */
  verifyWebhook(payload: Buffer, signature: string): WebhookVerificationResult {
    const secretHash = env.FLUTTERWAVE_SECRET_HASH
    if (!secretHash) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'FLUTTERWAVE_SECRET_HASH is not configured',
      }
    }
    if (!signature) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'Missing verif-hash header',
      }
    }

    if (!timingSafeCompare(secretHash, signature)) {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'verif-hash does not match configured secret hash',
      }
    }

    let parsed: { event?: string; data?: Record<string, unknown> }
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      return {
        valid: false,
        event: '',
        data: {},
        reason: 'verif-hash valid but body is not JSON',
      }
    }

    const data = parsed.data ?? {}

    return {
      valid: true,
      event: parsed.event ?? '',
      data,
      reference: typeof data.tx_ref === 'string' ? data.tx_ref : undefined,
      // Flutterwave reports the major unit.
      amountMajor: typeof data.amount === 'number' ? data.amount : undefined,
      currency: typeof data.currency === 'string' ? data.currency : undefined,
    }
  }

  /**
   * Authoritative server-to-server check. The webhook body is treated as a hint;
   * this response decides whether a plan is granted.
   */
  async confirmTransaction(
    data: Record<string, unknown>
  ): Promise<TransactionConfirmation> {
    const transactionId = data.id
    if (typeof transactionId !== 'number' && typeof transactionId !== 'string') {
      return { status: 'unknown', reason: 'Webhook contained no transaction id' }
    }

    try {
      const response = await axios.get(
        `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(String(transactionId))}/verify`,
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
        status: verified.status === 'successful' ? 'success' : 'failed',
        amountMajor:
          typeof verified.amount === 'number' ? verified.amount : undefined,
        currency:
          typeof verified.currency === 'string' ? verified.currency : undefined,
        metadata: (verified.meta as Record<string, unknown>) ?? undefined,
      }
    } catch (error) {
      // Never grant on a failed confirmation; the caller treats unknown as "retry".
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
    return (data.tx_ref as string) || ''
  }

  /** `tx_ref` is the reference this provider generated at initialization. */
  getIntentReferences(data: Record<string, unknown>): string[] {
    return typeof data.tx_ref === 'string' && data.tx_ref.length > 0
      ? [data.tx_ref]
      : []
  }
}
