import { Request, Response } from 'express'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { Payment, PaymentStatus } from '../entities/Payment'
import { AuthRequest } from '../middleware/auth'
import { defaultProvider, getProvider, isKnownProvider } from '../services/payments'
import type { WebhookVerificationResult } from '../services/payments'
import { sha256Hex } from '../services/payments/crypto.util'
import {
  PLANS,
  PlanId,
  isPlanId,
  resolveEffectivePlan,
} from '../services/plan.service'
import { revokeAllRefreshTokensForUser } from '../services/token.service'
import { env } from '../config/env'

/**
 * Plan catalogue lives in `plan.service.ts` — re-exported here only so existing
 * importers of `PLANS` from this module keep working.
 */
export { PLANS } from '../services/plan.service'

const SUBSCRIPTION_DAYS = 30

/** Amount tolerance in major units, to absorb provider rounding (e.g. USD cents). */
const AMOUNT_TOLERANCE = 1

const UPGRADE_EVENTS = new Set([
  'charge.success',
  'charge.completed',
  'payment_intent.succeeded',
  'checkout.session.completed',
  'invoice.paid',
])

const DOWNGRADE_EVENTS = new Set([
  'subscription.disable',
  'customer.subscription.deleted',
])

export const getPlans = async (_req: Request, res: Response): Promise<void> => {
  res.json({ plans: PLANS })
}

export const getCurrentPlan = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: req.user!.id },
    })
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    // The effective plan, not the stored column: an expired paid plan is free
    // (H-29), and a cancelled plan does not silently become perpetual (H-30).
    const effective = resolveEffectivePlan(user)

    res.json({
      current_plan: effective.id,
      stored_plan: user.plan,
      payment_provider: user.payment_provider,
      limits: effective,
      plan_expires_at: user.plan_expires_at ?? null,
      plan_expired: user.plan !== 'free' && effective.id === 'free',
    })
  } catch (error) {
    console.error('Get plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/** Body validated by `validateBody(initializePaymentSchema)`. */
export const initializePayment = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { plan, provider: providerName } = req.body as {
      plan: PlanId
      provider?: string
    }

    if (plan === 'free') {
      res.status(400).json({ error: 'Cannot pay for free plan' })
      return
    }

    if (providerName && !isKnownProvider(providerName)) {
      res.status(400).json({ error: 'Unknown payment provider' })
      return
    }

    const selectedPlan = PLANS[plan]
    const provider = providerName ? getProvider(providerName) : defaultProvider()

    const result = await provider.initializePayment(
      req.user!.email,
      // Amount comes from the server catalogue. The client sends a plan id and
      // never an amount, so there is no price to tamper with (H-06).
      selectedPlan.amount,
      selectedPlan.currency,
      {
        user_id: req.user!.id,
        plan,
        provider: provider.name,
      },
      `${env.FRONTEND_URL ?? ''}/dashboard/billing/success`
    )

    res.json(result)
  } catch (error) {
    console.error('Payment init error:', error)
    const errMsg =
      error instanceof Error ? error.message : 'Payment initialization failed'
    res.status(500).json({ error: errMsg })
  }
}

interface LedgerEntry {
  provider: string
  reference: string
  eventType: string
  userId?: string | null
  plan?: string | null
  amountMajor?: number
  currency?: string
  status: PaymentStatus
  reason?: string
  payloadDigest: string
}

/**
 * Records the webhook in the ledger.
 *
 * Returns `false` when `(provider, reference)` already exists, which is how replay
 * is detected: the unique constraint is the arbiter, not a prior SELECT, so two
 * concurrent deliveries of the same webhook cannot both win (H-06, H-37).
 */
const recordPayment = async (entry: LedgerEntry): Promise<boolean> => {
  const repo = AppDataSource.getRepository(Payment)
  const result = await repo
    .createQueryBuilder()
    .insert()
    .into(Payment)
    .values({
      user_id: isUuid(entry.userId) ? entry.userId : null,
      provider: entry.provider.slice(0, 50),
      // Provider-controlled strings are clamped to the column width so a long
      // value cannot turn a ledger write into a 500 (and lose the audit record).
      provider_reference: entry.reference.slice(0, 255),
      event_type: entry.eventType.slice(0, 100),
      amount_minor:
        entry.amountMajor === undefined
          ? null
          : String(Math.round(entry.amountMajor * 100)),
      currency: normaliseCurrency(entry.currency),
      plan: entry.plan?.slice(0, 50) ?? null,
      status: entry.status,
      reason: entry.reason ?? null,
      payload_digest: entry.payloadDigest,
    })
    .orIgnore()
    .execute()

  // `orIgnore` yields an empty identifiers array when the row already existed.
  return (result.identifiers?.length ?? 0) > 0
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `user_id` is a uuid column with a foreign key. A non-uuid value from webhook
 * metadata must not reach Postgres — it would raise a type error and abort the
 * ledger write that records the rejection.
 */
const isUuid = (value: string | null | undefined): value is string =>
  typeof value === 'string' && UUID_RE.test(value)

/** The column is varchar(3); anything else is not a currency code we can store. */
const normaliseCurrency = (value: string | undefined): string | null => {
  if (!value) return null
  const code = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(code) ? code : null
}

/**
 * Payment webhook handler.
 *
 * Mounted with `express.raw`, so `req.body` is the exact byte sequence the provider
 * signed. Every branch below either grants nothing or records why (H-05, H-06).
 */
export const handleWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : req.rawBody

  if (!rawBody) {
    console.error(
      'Payment webhook received without a raw body; the express.raw parser is not mounted on this route'
    )
    res.status(500).json({ error: 'Webhook body unavailable' })
    return
  }

  const payloadDigest = sha256Hex(rawBody)

  try {
    const { providerName, signature } = detectProvider(req)

    if (!isKnownProvider(providerName)) {
      res.status(400).json({ error: 'Unrecognised webhook source' })
      return
    }

    const provider = getProvider(providerName)
    const result = provider.verifyWebhook(rawBody, signature)

    if (!result.valid) {
      // Log the reason, never the payload or the presented signature.
      console.warn(
        `Rejected ${providerName} webhook: ${result.reason ?? 'signature mismatch'}`
      )
      await recordPayment({
        provider: providerName,
        // Digest keeps the ledger row unique without trusting unverified input.
        reference: `unverified:${payloadDigest.slice(0, 32)}`,
        eventType: 'unverified',
        status: 'rejected',
        reason: result.reason ?? 'Signature mismatch',
        payloadDigest,
      }).catch((error) => console.error('Ledger write failed:', error))

      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    if (UPGRADE_EVENTS.has(result.event)) {
      await handleUpgrade(providerName, result, payloadDigest, res)
      return
    }

    if (DOWNGRADE_EVENTS.has(result.event)) {
      await handleDowngrade(providerName, result, payloadDigest, res)
      return
    }

    // Verified but not an event we act on. Recorded so the ledger is complete.
    await recordPayment({
      provider: providerName,
      reference: result.reference ?? `ignored:${payloadDigest.slice(0, 32)}`,
      eventType: result.event || 'unknown',
      status: 'ignored',
      reason: 'Event type is not handled',
      payloadDigest,
    }).catch((error) => console.error('Ledger write failed:', error))

    res.status(200).json({ ok: true })
  } catch (error) {
    console.error('Webhook handler error:', error)
    // 500 so the provider retries; the ledger's unique constraint makes the retry safe.
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

const detectProvider = (
  req: Request
): { providerName: string; signature: string } => {
  const paystackSig = req.headers['x-paystack-signature']
  const stripeSig = req.headers['stripe-signature']
  const flutterwaveSig = req.headers['verif-hash']

  if (typeof stripeSig === 'string') {
    return { providerName: 'stripe', signature: stripeSig }
  }
  if (typeof flutterwaveSig === 'string') {
    return { providerName: 'flutterwave', signature: flutterwaveSig }
  }
  if (typeof paystackSig === 'string') {
    return { providerName: 'paystack', signature: paystackSig }
  }
  // No recognised signature header at all.
  return { providerName: 'unknown', signature: '' }
}

const readMetadata = (
  result: WebhookVerificationResult
): { userId?: string; plan?: string } => {
  const metadata = (result.data.metadata ??
    result.data.meta ??
    result.data) as Record<string, unknown>

  const userId = metadata.user_id
  const plan = metadata.plan

  return {
    userId: typeof userId === 'string' ? userId : undefined,
    plan: typeof plan === 'string' ? plan : undefined,
  }
}

const handleUpgrade = async (
  providerName: string,
  result: WebhookVerificationResult,
  payloadDigest: string,
  res: Response
): Promise<void> => {
  const provider = getProvider(providerName)
  const { userId, plan } = readMetadata(result)
  const reference = result.reference

  if (!reference) {
    await recordPayment({
      provider: providerName,
      reference: `noref:${payloadDigest.slice(0, 32)}`,
      eventType: result.event,
      status: 'rejected',
      reason: 'Webhook carried no provider reference; cannot deduplicate',
      payloadDigest,
    })
    res.status(200).json({ ok: true })
    return
  }

  const reject = async (reason: string): Promise<void> => {
    console.warn(`Refusing ${providerName} upgrade for ${reference}: ${reason}`)
    await recordPayment({
      provider: providerName,
      reference,
      eventType: result.event,
      userId,
      plan,
      amountMajor: result.amountMajor,
      currency: result.currency,
      status: 'rejected',
      reason,
      payloadDigest,
    })
    // 200: the webhook was genuine, we simply refuse to act on it. Returning an
    // error would make the provider retry a request that can never succeed.
    res.status(200).json({ ok: true })
  }

  if (!userId || !plan) {
    await reject('Webhook metadata did not identify a user and plan')
    return
  }

  if (!isUuid(userId)) {
    // `users.id` is a uuid column: querying it with arbitrary text raises a
    // Postgres type error, which would turn a bad webhook into a retry loop.
    await reject('Webhook metadata carried a malformed user id')
    return
  }

  if (!isPlanId(plan) || plan === 'free') {
    await reject(`Webhook requested an unknown or non-payable plan: ${plan}`)
    return
  }

  const expected = PLANS[plan]

  /**
   * Server-to-server confirmation where the provider offers it. This is the control
   * that makes amount tampering ineffective even if the webhook body is forged or
   * the metadata was manipulated client-side (H-06).
   */
  let confirmedAmount = result.amountMajor
  let confirmedCurrency = result.currency

  if (provider.confirmTransaction) {
    const confirmation = await provider.confirmTransaction(result.data)

    if (confirmation.status === 'unknown') {
      // Do not grant, and do not record a terminal outcome — let the provider retry.
      console.warn(
        `Deferring ${providerName} upgrade for ${reference}: ${confirmation.reason ?? 'confirmation unavailable'}`
      )
      res.status(503).json({ error: 'Confirmation unavailable; please retry' })
      return
    }

    if (confirmation.status === 'failed') {
      await reject('Provider reports the transaction was not successful')
      return
    }

    confirmedAmount = confirmation.amountMajor ?? confirmedAmount
    confirmedCurrency = confirmation.currency ?? confirmedCurrency
  }

  if (confirmedAmount === undefined) {
    await reject('Could not determine the charged amount')
    return
  }

  /**
   * Stripe charges in USD converted from the naira catalogue price, so the
   * comparison has to be done in the currency actually charged.
   */
  const expectedAmount =
    confirmedCurrency && confirmedCurrency.toUpperCase() !== 'NGN'
      ? expectedForeignAmount(expected.amount, confirmedCurrency)
      : expected.amount

  if (expectedAmount === undefined) {
    await reject(
      `Charged in ${confirmedCurrency}, which has no configured price for the ${plan} plan`
    )
    return
  }

  if (confirmedAmount + AMOUNT_TOLERANCE < expectedAmount) {
    await reject(
      `Underpayment: charged ${confirmedAmount} ${confirmedCurrency ?? 'NGN'}, expected at least ${expectedAmount}`
    )
    return
  }

  const userRepo = AppDataSource.getRepository(User)
  const user = await userRepo.findOne({ where: { id: userId } })
  if (!user) {
    await reject('Webhook referenced a user that does not exist')
    return
  }

  const isNew = await recordPayment({
    provider: providerName,
    reference,
    eventType: result.event,
    userId,
    plan,
    amountMajor: confirmedAmount,
    currency: confirmedCurrency,
    status: 'succeeded',
    payloadDigest,
  })

  if (!isNew) {
    // Already processed. Return success without extending the subscription again.
    console.log(
      `Ignoring duplicate ${providerName} webhook for reference ${reference}`
    )
    res.status(200).json({ ok: true, duplicate: true })
    return
  }

  /**
   * Extend from the later of "now" and the current expiry, so paying early tops up
   * the subscription instead of shortening it.
   */
  const currentExpiry = user.plan_expires_at
    ? new Date(user.plan_expires_at).getTime()
    : 0
  const extendFrom = Math.max(Date.now(), currentExpiry)
  const planExpiresAt = new Date(
    extendFrom + SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000
  )

  await userRepo.update(userId, {
    plan,
    payment_provider: providerName,
    payment_customer_id: provider.getCustomerId(result.data),
    payment_subscription_id: provider.getSubscriptionId(result.data),
    plan_expires_at: planExpiresAt,
  })

  console.log(
    `User ${userId} upgraded to ${plan} via ${providerName} until ${planExpiresAt.toISOString()}`
  )
  res.status(200).json({ ok: true })
}

/**
 * Foreign-currency price for a plan.
 *
 * Only USD is derived, matching the single non-NGN checkout the Stripe provider
 * creates. Anything else is refused rather than approximated, because approximating
 * here is how an underpayment slips through.
 */
const expectedForeignAmount = (
  amountNgn: number,
  currency: string
): number | undefined => {
  if (currency.toUpperCase() !== 'USD') return undefined
  return amountNgn / env.NGN_PER_USD
}

const handleDowngrade = async (
  providerName: string,
  result: WebhookVerificationResult,
  payloadDigest: string,
  res: Response
): Promise<void> => {
  const { userId } = readMetadata(result)
  const reference = result.reference ?? `cancel:${payloadDigest.slice(0, 32)}`

  if (!isUuid(userId)) {
    await recordPayment({
      provider: providerName,
      reference,
      eventType: result.event,
      status: 'rejected',
      reason: 'Cancellation webhook did not identify a valid user',
      payloadDigest,
    })
    res.status(200).json({ ok: true })
    return
  }

  const isNew = await recordPayment({
    provider: providerName,
    reference,
    eventType: result.event,
    userId,
    plan: 'free',
    status: 'succeeded',
    payloadDigest,
  })

  if (!isNew) {
    res.status(200).json({ ok: true, duplicate: true })
    return
  }

  /**
   * Downgrade to free with an expiry in the past.
   *
   * Previously this set `plan_expires_at` to `undefined` while leaving the paid
   * plan in place, which — once expiry is actually enforced — reads as a plan that
   * never expires. Cancellation must not be an upgrade (H-30).
   */
  await AppDataSource.getRepository(User).update(userId, {
    plan: 'free',
    plan_expires_at: new Date(0),
    payment_subscription_id: '',
  })

  // Force new access tokens so the stale `plan` claim cannot outlive the downgrade.
  await revokeAllRefreshTokensForUser(userId).catch((error) =>
    console.error('Failed to revoke sessions after downgrade:', error)
  )

  console.log(`User ${userId} downgraded to free via ${providerName}`)
  res.status(200).json({ ok: true })
}
