export interface InitializePaymentResult {
  authorization_url: string
  reference: string
  provider: string
}

export interface WebhookVerificationResult {
  valid: boolean
  event: string
  data: Record<string, unknown>
}

export interface PaymentProvider {
  name: string
  initializePayment(
    email: string,
    amount: number,
    currency: string,
    metadata: Record<string, unknown>,
    callbackUrl: string
  ): Promise<InitializePaymentResult>
  verifyWebhook(payload: string, signature: string): WebhookVerificationResult
  getCustomerId(data: Record<string, unknown>): string
  getSubscriptionId(data: Record<string, unknown>): string
}
