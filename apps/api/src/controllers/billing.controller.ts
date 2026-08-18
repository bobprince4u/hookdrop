import { Request, Response } from 'express'
import { MoreThanOrEqual } from 'typeorm'
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

/**
 * Underpayment tolerance, in the MINOR unit of the currency actually charged.
 *
 * This was `1` **major** unit. Harmless against a ₦7,500 naira plan (0.013%), and a
 * hole against the same plan billed through Stripe: ₦7,500 at the configured rate is
 * ≈$4.69, so a $1 tolerance accepted a ~21% underpayment.
 *
 * One minor unit is the smallest value that still absorbs the only legitimate
 * discrepancy — the half-cent rounding in `StripeProvider.toUsdCents`, where
 * `Math.round(x * 100)` can land a cent either side of the exact conversion.
 */
const AMOUNT_TOLERANCE_MINOR = 1

/**
 * Both currencies this system charges in have 100 minor units, and
 * `expectedForeignAmount` refuses any currency other than NGN and USD outright, so a
 * fixed factor is correct here. A zero-decimal currency such as JPY would require the
 * exponent to be looked up per code.
 */
const MINOR_UNITS_PER_MAJOR = 100

/**
 * All amount comparison happens in minor units, so the check never rests on float
 * equality of values like 3.125 that arise from the NGN→USD division.
 */
const toMinor = (major: number): number =>
  Math.round(major * MINOR_UNITS_PER_MAJOR)

/** `reason` is free text from our own code, but can embed provider-supplied strings. */
const MAX_REASON_CHARS = 1000

/**
 * Intent rows are namespaced so they cannot collide with the outcome row for the same
 * transaction.
 *
 * Paystack returns the *same* reference in its webhook that it returned at
 * initialization, so an un-namespaced intent row would occupy
 * `(provider, provider_reference)` first — and then the `.orIgnore()` insert of the
 * `succeeded` row would find a conflict, report `isNew = false`, and silently refuse
 * every genuine upgrade as a duplicate. The prefix follows the convention already used
 * for `unverified:`, `ignored:`, `noref:` and `cancel:`.
 *
 * Clamped here rather than at the write site so the lookup and the insert always
 * derive byte-identical keys, even for a reference long enough to hit the column width.
 */
const INTENT_PREFIX = 'intent:'
const PROVIDER_REFERENCE_MAX = 255

const intentReference = (reference: string): string =>
  `${INTENT_PREFIX}${reference}`.slice(0, PROVIDER_REFERENCE_MAX)

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

/**
 * Server-side verification of a checkout return (H-28).
 *
 * Replaces a success page that decided the outcome from a 2-second timer plus any HTTP
 * 200, so `?reference=anything` rendered "payment successful" and a slow webhook
 * rendered "you are now on the free plan".
 *
 * Two properties make this trustworthy:
 *  1. The reference must match an intent row **owned by the caller**. An arbitrary or
 *     someone else's reference is a 404, not a success screen.
 *  2. "Activated" is derived from the user's effective plan, which only the webhook
 *     can set. This endpoint reports the grant; it never performs one.
 *
 * Accepts `session_id` as well as `reference` because the Stripe provider's
 * `success_url` returns `?session_id={CHECKOUT_SESSION_ID}` while the other two return
 * `reference` — the frontend previously read only the latter and bounced every Stripe
 * payer off their own success page.
 *
 * Query params are read defensively rather than through `validatedQuery()` so this
 * handler is correct whether or not a validator is mounted in front of it.
 */
export const verifyPayment = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const raw = req.query.reference ?? req.query.session_id
    const reference =
      typeof raw === 'string' && raw.length > 0 && raw.length <= 255
        ? raw
        : null

    if (!reference) {
      res.status(400).json({
        error: 'A reference or session_id query parameter is required',
      })
      return
    }

    const userId = req.user!.id

    const intent = await AppDataSource.getRepository(Payment).findOne({
      where: {
        provider_reference: intentReference(reference),
        status: 'initiated',
        user_id: userId,
      },
    })

    if (!intent) {
      // Same answer for "never existed" and "belongs to someone else".
      res.status(404).json({
        status: 'unknown',
        error: 'No payment matching that reference was initiated by this account',
      })
      return
    }

    const user = await AppDataSource.getRepository(User).findOne({
      where: { id: userId },
    })
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const effective = resolveEffectivePlan(user)

    /**
     * Matching the plan is not sufficient on its own. A renewal or a repeat purchase of
     * the plan the user is *already* on would match before the webhook has landed, so
     * the plan comparison alone would report success for a payment that has not yet
     * been confirmed — the same optimism this endpoint exists to remove.
     *
     * A `succeeded` ledger row for this user dated at or after the intent is the
     * evidence that a grant actually happened during this checkout. It works for every
     * provider without needing to correlate references: Stripe's outcome row is keyed
     * on `event.id`, which has no relationship to the checkout session id, so a
     * reference join would silently never match there.
     */
    const grant = await AppDataSource.getRepository(Payment).findOne({
      where: {
        user_id: userId,
        status: 'succeeded',
        created_at: MoreThanOrEqual(intent.created_at),
      },
      order: { created_at: 'DESC' },
    })

    const activated =
      grant !== null && intent.plan !== null && effective.id === intent.plan

    res.json({
      // `pending` is a real, expected state: the provider redirects the browser back
      // before the webhook necessarily lands. The client polls rather than assumes.
      status: activated ? 'active' : 'pending',
      requested_plan: intent.plan,
      current_plan: effective.id,
      provider: intent.provider,
      plan_expires_at: user.plan_expires_at ?? null,
      initiated_at: intent.created_at,
    })
  } catch (error) {
    console.error('Payment verification error:', error)
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

    /**
     * Record the intent before handing back the redirect URL.
     *
     * This row is the server's own statement of who asked for which plan at what
     * price. The webhook resolves the grant from it instead of from `metadata.plan` —
     * which we do send, but which travels to the provider and, for hosted checkout,
     * through the user's browser, so it authorises nothing on the way back (H-06).
     *
     * A failure here is logged and swallowed rather than failing the checkout: the
     * webhook still has the metadata fallback, and refusing to sell because a ledger
     * write hiccuped is the worse outcome. The consequence is recorded in the fallback
     * path's reason string, so a missing intent is visible in the ledger afterwards.
     */
    await recordPayment({
      provider: provider.name,
      reference: intentReference(result.reference),
      eventType: 'payment.initialized',
      userId: req.user!.id,
      plan,
      amountMajor: selectedPlan.amount,
      currency: selectedPlan.currency,
      status: 'initiated',
    }).catch((error) =>
      console.error('Failed to record payment intent:', error)
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
  /** Absent for intent rows, which are written before any payload exists. */
  payloadDigest?: string
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
      provider_reference: entry.reference.slice(0, PROVIDER_REFERENCE_MAX),
      event_type: entry.eventType.slice(0, 100),
      amount_minor:
        entry.amountMajor === undefined
          ? null
          : String(toMinor(entry.amountMajor)),
      currency: normaliseCurrency(entry.currency),
      /**
       * Normalised to a known plan id or NULL — not merely clamped to the column
       * width.
       *
       * On the rejection path `entry.plan` is whatever the webhook metadata claimed,
       * and `payments_plan_check` would abort the INSERT on an unrecognised value,
       * destroying the audit record of the very webhook being rejected. The requested
       * string is preserved in `reason`, which is unconstrained text.
       */
      plan: isPlanId(entry.plan) ? entry.plan : null,
      status: entry.status,
      reason: entry.reason?.slice(0, MAX_REASON_CHARS) ?? null,
      payload_digest: entry.payloadDigest ?? null,
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
  const metadata = readMetadata(result)
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

  /**
   * Resolve who and what from the intent row this server wrote at initialization,
   * falling back to webhook metadata only when no intent exists.
   *
   * This is the control that turns the ledger from a record of the outcome into the
   * thing that authorises it. `metadata.user_id` and `metadata.plan` are values we
   * handed the provider, which then travelled through hosted checkout and back; the
   * intent row never left this server.
   *
   * The fallback is kept deliberately, for two real cases: payments initiated before
   * this change that are still in flight, and Stripe subscription renewals, which
   * arrive as `invoice.paid` with no checkout session and therefore no intent. Which
   * source was used is recorded in the ledger so it is auditable rather than assumed.
   */
  const intent = await findIntent(
    providerName,
    provider.getIntentReferences?.(result.data) ?? []
  )

  const resolvedUserId = intent?.user_id ?? metadata.userId
  const resolvedPlan = intent?.plan ?? metadata.plan
  /**
   * Reports what actually supplied the values, not merely whether a row was found. An
   * intent row with a null `user_id` or `plan` falls through to metadata field by
   * field, and this string ends up in rejection reasons and the grant log, so it has
   * to name the real source or the audit trail misleads.
   */
  const authority =
    intent?.user_id && intent?.plan
      ? 'intent row'
      : intent
        ? 'intent row with metadata fallback'
        : 'webhook metadata'

  if (
    intent &&
    metadata.plan &&
    metadata.plan !== intent.plan
  ) {
    // Not fatal — the intent wins — but a mismatch means metadata was altered in
    // transit, which is worth seeing in the ledger.
    console.warn(
      `Webhook metadata for ${reference} claimed plan ${metadata.plan} but the recorded intent was ${intent.plan}; using the intent`
    )
  }

  const reject = async (reason: string): Promise<void> => {
    console.warn(`Refusing ${providerName} upgrade for ${reference}: ${reason}`)
    await recordPayment({
      provider: providerName,
      reference,
      eventType: result.event,
      userId: resolvedUserId,
      plan: resolvedPlan,
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

  if (!resolvedUserId || !resolvedPlan) {
    await reject(
      `Neither an intent row nor webhook metadata identified a user and plan for ${reference}`
    )
    return
  }

  if (!isUuid(resolvedUserId)) {
    // `users.id` is a uuid column: querying it with arbitrary text raises a
    // Postgres type error, which would turn a bad webhook into a retry loop.
    await reject(`Malformed user id from ${authority}`)
    return
  }

  if (!isPlanId(resolvedPlan) || resolvedPlan === 'free') {
    await reject(
      `Unknown or non-payable plan from ${authority}: ${resolvedPlan}`
    )
    return
  }

  const expected = PLANS[resolvedPlan]

  /**
   * Price to verify against: the amount recorded when the payment was initiated, so a
   * catalogue price change while the user sat on the provider's checkout page cannot
   * retroactively make a completed payment an underpayment. Falls back to the current
   * catalogue when there is no intent row to compare against.
   *
   * `amount_minor` is a `bigint` column, which pg returns as a string.
   */
  const intentNgn =
    intent?.amount_minor == null
      ? undefined
      : Number(intent.amount_minor) / MINOR_UNITS_PER_MAJOR

  const expectedNgn =
    intentNgn !== undefined && Number.isFinite(intentNgn)
      ? intentNgn
      : expected.amount

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
      ? expectedForeignAmount(expectedNgn, confirmedCurrency)
      : expectedNgn

  if (expectedAmount === undefined) {
    await reject(
      `Charged in ${confirmedCurrency}, which has no configured price for the ${resolvedPlan} plan`
    )
    return
  }

  /**
   * Compared in minor units so the tolerance means "one kobo" / "one cent" rather
   * than "one naira" / "one dollar", and so the NGN→USD division (e.g. 4.6875) never
   * has to be compared as a float.
   */
  const confirmedMinor = toMinor(confirmedAmount)
  const expectedMinor = toMinor(expectedAmount)

  if (confirmedMinor + AMOUNT_TOLERANCE_MINOR < expectedMinor) {
    await reject(
      `Underpayment: charged ${confirmedMinor} minor units of ${confirmedCurrency ?? 'NGN'}, expected at least ${expectedMinor}`
    )
    return
  }

  const userRepo = AppDataSource.getRepository(User)
  const user = await userRepo.findOne({ where: { id: resolvedUserId } })
  if (!user) {
    await reject(`${authority} referenced a user that does not exist`)
    return
  }

  const isNew = await recordPayment({
    provider: providerName,
    reference,
    eventType: result.event,
    userId: resolvedUserId,
    plan: resolvedPlan,
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

  await userRepo.update(resolvedUserId, {
    plan: resolvedPlan,
    payment_provider: providerName,
    payment_customer_id: provider.getCustomerId(result.data) || null,
    payment_subscription_id: provider.getSubscriptionId(result.data) || null,
    plan_expires_at: planExpiresAt,
  })

  console.log(
    `User ${resolvedUserId} upgraded to ${resolvedPlan} via ${providerName} (authorised by ${authority}) until ${planExpiresAt.toISOString()}`
  )
  res.status(200).json({ ok: true })
}

/**
 * Finds the intent row written when this payment was initialized.
 *
 * Candidates are tried in the order the provider supplies them, most specific first.
 * The lookup is `status = 'initiated'` so it can never match an outcome row.
 */
const findIntent = async (
  providerName: string,
  candidates: string[]
): Promise<Payment | null> => {
  if (candidates.length === 0) return null

  const repo = AppDataSource.getRepository(Payment)

  for (const candidate of candidates) {
    const row = await repo.findOne({
      where: {
        provider: providerName,
        provider_reference: intentReference(candidate),
        status: 'initiated',
      },
    })
    if (row) return row
  }

  return null
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
  const provider = getProvider(providerName)
  const { userId: metadataUserId } = readMetadata(result)
  const reference = result.reference ?? `cancel:${payloadDigest.slice(0, 32)}`

  const userRepo = AppDataSource.getRepository(User)

  /**
   * Resolve the account from the provider's own identifiers before falling back to
   * metadata.
   *
   * Metadata alone did not work: Stripe's `customer.subscription.deleted` carries no
   * metadata at all, so every Stripe cancellation hit the `!isUuid(userId)` branch and
   * was recorded as "did not identify a valid user" — leaving a cancelled customer on
   * a paid plan until the expiry date they had already stopped paying for (H-30).
   *
   * `payment_subscription_id` is the value stored when the subscription was created,
   * so it is the reliable key; `payment_customer_id` is the fallback for events that
   * name only the customer; metadata is last, for providers that do send it.
   */
  const subscriptionId = provider.getSubscriptionId(result.data)
  const customerId = provider.getCustomerId(result.data)

  let user: User | null = null
  let resolvedVia = 'none'

  if (subscriptionId) {
    user = await userRepo.findOne({
      where: { payment_subscription_id: subscriptionId },
    })
    if (user) resolvedVia = 'payment_subscription_id'
  }

  if (!user && customerId) {
    user = await userRepo.findOne({
      where: { payment_customer_id: customerId },
    })
    if (user) resolvedVia = 'payment_customer_id'
  }

  if (!user && isUuid(metadataUserId)) {
    user = await userRepo.findOne({ where: { id: metadataUserId } })
    if (user) resolvedVia = 'webhook metadata'
  }

  if (!user) {
    await recordPayment({
      provider: providerName,
      reference,
      eventType: result.event,
      status: 'rejected',
      reason:
        'Cancellation webhook could not be matched to an account by subscription id, customer id or metadata',
      payloadDigest,
    })
    res.status(200).json({ ok: true })
    return
  }

  const userId = user.id

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
   * Downgrade to free and clear the expiry entirely.
   *
   * The original code set `plan_expires_at` to `undefined` while leaving the paid plan
   * in place, which — once expiry is enforced — reads as a plan that never expires, so
   * cancellation was an upgrade. The interim fix used `new Date(0)`, which works but
   * encodes "cancelled" as a 1970 timestamp. NULL is the honest representation: on a
   * free plan `resolveEffectivePlan` returns the free limits without consulting the
   * expiry at all, and NULL keeps the column out of the partial index used to find
   * active subscriptions.
   *
   * The subscription id is cleared to NULL rather than `''` so it cannot be matched by
   * a later cancellation carrying an empty identifier.
   */
  await userRepo.update(userId, {
    plan: 'free',
    plan_expires_at: null,
    payment_subscription_id: null,
  })

  // Force new access tokens so the stale `plan` claim cannot outlive the downgrade.
  await revokeAllRefreshTokensForUser(userId).catch((error) =>
    console.error('Failed to revoke sessions after downgrade:', error)
  )

  console.log(
    `User ${userId} downgraded to free via ${providerName} (matched by ${resolvedVia})`
  )
  res.status(200).json({ ok: true })
}
