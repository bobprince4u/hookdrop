import {
  PaymentProvider,
  InitializePaymentResult,
  WebhookVerificationResult,
} from './provider.interface'

export class StripeProvider implements PaymentProvider {
  name = 'stripe'

  async initializePayment(
    _email: string,
    _amount: number,
    _currency: string,
    _metadata: Record<string, unknown>,
    _callbackUrl: string
  ): Promise<InitializePaymentResult> {
    // TODO: implement when Stripe is added
    throw new Error('Stripe provider not yet implemented')
  }

  verifyWebhook(
    _payload: string,
    _signature: string
  ): WebhookVerificationResult {
    // TODO: implement when Stripe is added
    throw new Error('Stripe provider not yet implemented')
  }

  getCustomerId(_data: Record<string, unknown>): string {
    return ''
  }

  getSubscriptionId(_data: Record<string, unknown>): string {
    return ''
  }
}
