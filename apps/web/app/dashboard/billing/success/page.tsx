'use client'

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import Image from 'next/image'
import { useAuthStore } from '@/lib/auth'

export default function BillingSuccessPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const reference = searchParams.get('reference')
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying')
  const [plan, setPlan] = useState('')

  useEffect(() => {
    if (!reference) {
      router.push('/dashboard/billing')
      return
    }

    // Give Paystack webhook a moment to process
    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/api/billing/current')
        setPlan(res.data.current_plan)
        useAuthStore.getState().refreshPlan()
        setStatus('success')
      } catch {
        setStatus('error')
      }
    }, 2000)

    return () => clearTimeout(timer)
  }, [reference, router])

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#030712' }}>
      <div className="text-center max-w-md">
        <Image
          src="/hookdroplogo.png"
          alt="Hookdrop"
          width={64}
          height={64}
          className="mx-auto mb-6 rounded-2xl"
        />

        {status === 'verifying' && (
          <>
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold mb-2">Verifying payment...</h1>
            <p className="text-zinc-500 text-sm">Please wait while we confirm your payment.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)' }}
            >
              ✓
            </div>
            <h1 className="text-2xl font-semibold mb-2">Payment successful!</h1>
            <p className="text-zinc-400 text-sm mb-2">
              You are now on the <span className="text-white font-medium capitalize">{plan}</span> plan.
            </p>
            <p className="text-zinc-500 text-xs mb-8">
              Reference: <code className="text-zinc-400">{reference}</code>
            </p>
            <div className="flex gap-3 justify-center">
              <Link
                href="/dashboard"
                className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
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

        {status === 'error' && (
          <>
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl"
              style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}
            >
              !
            </div>
            <h1 className="text-2xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-zinc-400 text-sm mb-8">
              Your payment may have been processed. Please check your billing page or contact support.
            </p>
            <Link
              href="/dashboard/billing"
              className="text-sm font-medium px-6 py-2.5 rounded-xl text-white transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
            >
              Check billing
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
