'use client'

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { api, describeApiError } from '@/lib/api'
import { useAuthStore } from '@/lib/auth'
import Link from 'next/link'
import Image from 'next/image'

/**
 * Checkout return page (H-28).
 *
 * ## What it used to do
 *
 * Wait two seconds, `GET /api/billing/current`, and declare success on any HTTP 200.
 * Three things follow from that, all of them observed rather than theoretical:
 *
 *  - **`?reference=anything` showed "Payment successful!"** The reference was never sent
 *    anywhere. It was read to decide whether to stay on the page, then printed back to the
 *    user as if it had been checked.
 *  - **A slow webhook produced "You are now on the free plan."** `current_plan` is
 *    whatever the account holds *now*; two seconds is not long enough for a provider
 *    webhook to arrive, so the page cheerfully rendered the pre-payment plan as the
 *    outcome of the payment.
 *  - **Every Stripe payer was redirected away from their own success page.** The Stripe
 *    provider sets `success_url=…?session_id={CHECKOUT_SESSION_ID}`; this page read only
 *    `reference`, found none, and bounced to `/dashboard/billing`.
 *
 * ## What it does now
 *
 * Polls `GET /api/billing/verify`, which resolves the reference against an intent row
 * **owned by the caller** and reports activation from the user's effective plan — a grant
 * only the webhook can make. So the three states this page can honestly be in are the
 * three it now renders: activated, still pending, or not a payment this account started.
 *
 * `pending` is not an error. The provider redirects the browser back before the webhook
 * necessarily lands, and the gap is normally under a second and occasionally much longer.
 * The poll backs off over roughly half a minute and then hands the user a "check again"
 * button instead of either spinning forever or claiming a failure that has not happened.
 */

/**
 * Cumulative wait: ~31s. Front-loaded because the webhook usually arrives while the
 * browser is still being redirected, and stretched at the tail so a slow provider does not
 * cost thirty requests.
 */
const POLL_DELAYS_MS = [0, 2_000, 3_000, 5_000, 8_000, 13_000] as const

type VerifyState =
  | 'verifying'
  | 'active'
  | 'pending'
  | 'no-reference'
  | 'unknown'
  | 'error'

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined

export default function BillingSuccessContent() {
  const searchParams = useSearchParams()
  // Selected individually: subscribing to the whole store would re-render this page on
  // every unrelated auth state change, including the one `refreshPlan` itself causes.
  const refreshPlan = useAuthStore((s) => s.refreshPlan)

  /**
   * Paystack and Flutterwave return `reference`; Stripe returns `session_id`. Both are
   * accepted here and by the verify endpoint, which is what stops Stripe payers being
   * bounced off this page.
   */
  const reference = searchParams.get('reference')
  const sessionId = searchParams.get('session_id')
  const lookup = reference ?? sessionId
  const paramName = reference ? 'reference' : 'session_id'

  const [state, setState] = useState<VerifyState>('verifying')
  const [plan, setPlan] = useState('')
  const [error, setError] = useState('')
  /** Bumped by the "check again" button to re-run the polling effect. */
  const [attempt, setAttempt] = useState(0)

  /**
   * Derived, not stored. With no reference there is nothing to poll and nothing to wait
   * for, so this is a fact about the URL rather than a result the effect discovers —
   * writing it from the effect would only schedule a second render to reach a conclusion
   * already available during the first.
   *
   * Previously a `router.push` to the billing page, which threw away the one piece of
   * evidence the user had that they paid. Telling them beats redirecting them.
   */
  const view: VerifyState = lookup ? state : 'no-reference'

  const retry = useCallback(() => {
    setState('verifying')
    setAttempt((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!lookup) return

    let cancelled = false

    const poll = async (): Promise<void> => {
      for (const delay of POLL_DELAYS_MS) {
        if (delay > 0) await wait(delay)
        if (cancelled) return

        try {
          const res = await api.get('/api/billing/verify', {
            params: { [paramName]: lookup },
          })
          if (cancelled) return

          const requested = res.data?.requested_plan
          if (typeof requested === 'string') setPlan(requested)

          if (res.data?.status === 'active') {
            setState('active')
            // The plan claim in the current access token predates the upgrade, so the
            // dashboard would otherwise keep showing the old plan until the next refresh.
            void refreshPlan()
            return
          }
        } catch (err) {
          if (cancelled) return

          const status = statusOf(err)

          // 404: no intent row for this account. 400: no usable reference. Both mean the
          // reference cannot be verified, and neither is worth retrying.
          if (status === 404 || status === 400) {
            setState('unknown')
            return
          }

          console.error('Payment verification failed:', describeApiError(err))
          setError(describeApiError(err))
          setState('error')
          return
        }
      }

      // Every attempt returned `pending`. The payment is very likely fine and the webhook
      // is late; say exactly that rather than reporting a failure.
      if (!cancelled) setState('pending')
    }

    void poll()

    return () => {
      cancelled = true
    }
  }, [lookup, paramName, refreshPlan, attempt])

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: '#030712' }}
    >
      <div className="text-center max-w-md">
        <Image
          src="/hookdroplogo.png"
          alt="Hookdrop"
          width={64}
          height={64}
          className="mx-auto mb-6 rounded-2xl"
        />

        {view === 'verifying' && (
          <>
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold mb-2">Confirming your payment...</h1>
            <p className="text-zinc-500 text-sm">
              This usually takes a few seconds. Please keep this page open.
            </p>
          </>
        )}

        {view === 'active' && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{
                background: 'rgba(34,197,94,0.15)',
                border: '1px solid rgba(34,197,94,0.3)',
              }}
            >
              ✓
            </div>
            <h1 className="text-2xl font-semibold mb-2">Payment confirmed</h1>
            <p className="text-zinc-400 text-sm mb-2">
              You are now on the{' '}
              <span className="text-white font-medium capitalize">{plan}</span> plan.
            </p>
            <p className="text-zinc-500 text-xs mb-8">
              Reference: <code className="text-zinc-400 break-all">{lookup}</code>
            </p>
            <div className="flex gap-3 justify-center">
              <Link
                href="/dashboard"
                className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
                style={{
                  background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Go to dashboard
              </Link>
              <Link
                href="/dashboard/billing"
                className="text-sm px-6 py-2.5 rounded-xl border text-zinc-300 hover:text-white transition-colors"
                style={{ borderColor: 'rgba(255,255,255,0.1)' }}
              >
                View billing
              </Link>
            </div>
          </>
        )}

        {view === 'pending' && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{
                background: 'rgba(234,179,8,0.15)',
                border: '1px solid rgba(234,179,8,0.3)',
              }}
            >
              ⏳
            </div>
            <h1 className="text-2xl font-semibold mb-2">Activation pending</h1>
            <p className="text-zinc-400 text-sm mb-2">
              We have your payment{plan ? ` for the ${plan} plan` : ''}, but your provider
              has not confirmed it yet. Nothing is lost — your plan activates
              automatically as soon as the confirmation arrives.
            </p>
            <p className="text-zinc-500 text-xs mb-8">
              Reference: <code className="text-zinc-400 break-all">{lookup}</code>
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={retry}
                className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
                style={{
                  background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Check again
              </button>
              <Link
                href="/dashboard/billing"
                className="text-sm px-6 py-2.5 rounded-xl border text-zinc-300 hover:text-white transition-colors"
                style={{ borderColor: 'rgba(255,255,255,0.1)' }}
              >
                View billing
              </Link>
            </div>
          </>
        )}

        {(view === 'unknown' || view === 'no-reference') && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
              }}
            >
              ?
            </div>
            <h1 className="text-2xl font-semibold mb-2">
              No payment to confirm
            </h1>
            <p className="text-zinc-400 text-sm mb-8">
              {view === 'no-reference'
                ? 'This page was opened without a payment reference, so there is nothing to verify.'
                : 'We could not find a payment started by this account with that reference. If you were charged, check your billing page — and contact support with the reference if it does not appear.'}
            </p>
            <Link
              href="/dashboard/billing"
              className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
              style={{
                background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
              }}
            >
              Go to billing
            </Link>
          </>
        )}

        {view === 'error' && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.3)',
              }}
            >
              !
            </div>
            <h1 className="text-2xl font-semibold mb-2">
              Could not check your payment
            </h1>
            <p className="text-zinc-400 text-sm mb-2">
              {/* Deliberately not "your payment failed" — we do not know that. */}
              This is a problem reaching us, not a problem with your payment. If you were
              charged, your plan will still activate.
            </p>
            {error && <p className="text-zinc-500 text-xs mb-8">{error}</p>}
            <div className="flex gap-3 justify-center">
              <button
                onClick={retry}
                className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
                style={{
                  background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Try again
              </button>
              <Link
                href="/dashboard/billing"
                className="text-sm px-6 py-2.5 rounded-xl border text-zinc-300 hover:text-white transition-colors"
                style={{ borderColor: 'rgba(255,255,255,0.1)' }}
              >
                Check billing
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
