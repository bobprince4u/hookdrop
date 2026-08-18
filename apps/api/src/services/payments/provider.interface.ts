export interface InitializePaymentResult {
  authorization_url: string
  reference: string
  provider: string
}

export interface WebhookVerificationResult {
  valid: boolean
  event: string
  data: Record<string, unknown>
  /**
   * Provider-unique identifier for this transaction, used as the idempotency key
   * in the payments ledger. Without it a replayed webhook extends a subscription
   * again (H-06, H-37).
   */
  reference?: string
  /**
   * Amount actually charged, normalised to the major currency unit (naira,
   * dollars) so it can be compared against the plan catalogue regardless of
   * whether the provider reports kobo, cents or naira.
   */
  amountMajor?: number
  currency?: string
  /** Why verification failed. Safe to log: never contains a secret. */
  reason?: string
}

/**
 * Result of an authoritative server-to-server transaction lookup.
 *
 * `unknown` is deliberately distinct from `failed`: a network error must not be
 * read as "the customer did not pay", and must never grant a plan either.
 */
export interface TransactionConfirmation {
  status: 'success' | 'failed' | 'unknown'
  amountMajor?: number
  currency?: string
  metadata?: Record<string, unknown>
  reason?: string
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
  /**
   * Verifies a webhook against the EXACT bytes received.
   *
   * The parameter is a `Buffer`, not a string, because the previous signature
   * accepted `JSON.stringify(req.body)` — a re-serialisation whose byte sequence
   * differs from what the provider signed (key order, whitespace, unicode
   * escaping), so no signature could ever match correctly (H-05).
   */
  verifyWebhook(payload: Buffer, signature: string): WebhookVerificationResult
  /**
   * Optional second factor. Implemented by providers whose webhook body is not
   * itself cryptographically bound to the transaction, so the charged amount is
   * read back from the provider before anything is granted (H-06).
   */
  confirmTransaction?(
    data: Record<string, unknown>
  ): Promise<TransactionConfirmation>
  getCustomerId(data: Record<string, unknown>): string
  getSubscriptionId(data: Record<string, unknown>): string
}
