'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/auth'
import Link from 'next/link'

interface Plan {
  name: string
  amount: number
  events: number
  retention_hours: number
}

interface Plans {
  [key: string]: Plan
}

export default function BillingPage() {
  const { user } = useAuthStore()
  const [plans, setPlans] = useState<Plans>({})
  const [currentPlan, setCurrentPlan] = useState<string>('free')
  const [paymentMode, setPaymentMode] = useState<'test' | 'live'>('test')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.get('/api/billing/plans').then((res) => setPlans(res.data.plans))
    api
      .get('/api/billing/current')
      .then((res) => setCurrentPlan(res.data.current_plan))
    api.get('/api/billing/mode').then((res) => setPaymentMode(res.data.mode))
  }, [])

  const handleUpgrade = async (plan: string) => {
    if (paymentMode === 'test') return
    setLoading(true)
    try {
      const res = await api.post('/api/billing/initialize', { plan })
      window.location.href = res.data.authorization_url
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const formatRetention = (hours: number) => {
    if (hours < 24) return `${hours} hours`
    const days = hours / 24
    if (days < 30) return `${days} days`
    return `${Math.round(days / 30)} months`
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold mb-2">Billing</h1>
      <p className="text-sm text-zinc-500 mb-6">
        You are currently on the{' '}
        <span className="text-white capitalize">{currentPlan}</span> plan.
      </p>

      {/* Early access banner */}
      {paymentMode === 'test' && (
        <div
          className="rounded-2xl p-5 mb-8 border"
          style={{
            background: 'rgba(79,70,229,0.08)',
            borderColor: 'rgba(79,70,229,0.25)',
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0 mt-0.5"
              style={{ background: 'rgba(79,70,229,0.2)', color: '#818CF8' }}
            >
              ✦
            </div>
            <div>
              <h3 className="font-medium text-sm mb-1">
                Early access — first 20 developers get Pro free
              </h3>
              <p className="text-xs text-zinc-400 leading-relaxed mb-3">
                Hookdrop is currently in early access. Paid plans are not yet
                active — we are completing payment verification. As a thank you
                to early users, the first 20 developers who sign up get 3 months
                of Pro plan absolutely free.
              </p>

              <a
                href="mailto:hello@hookdrop.dev?subject=Early Access Pro Plan&body=Hi, I would like to claim my free Pro plan. My account email is: "
                className="inline-flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Claim your free Pro plan →
              </a>
              <p className="text-xs text-zinc-600 mt-2">
                Send us your account email and we will upgrade you within 24
                hours.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Object.entries(plans).map(([key, plan]) => (
          <div
            key={key}
            className="rounded-2xl p-6 border transition-all relative"
            style={{
              background:
                currentPlan === key
                  ? 'rgba(79,70,229,0.08)'
                  : 'rgba(255,255,255,0.02)',
              borderColor:
                currentPlan === key
                  ? 'rgba(79,70,229,0.3)'
                  : 'rgba(255,255,255,0.06)',
            }}
          >
            {currentPlan === key && (
              <div
                className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-medium px-3 py-1 rounded-full text-white whitespace-nowrap"
                style={{
                  background: 'linear-gradient(135deg, #3B82F6, #4F46E5)',
                }}
              >
                Current plan
              </div>
            )}

            <h3 className="font-semibold mb-1">{plan.name}</h3>
            <div className="flex items-baseline gap-0.5 mb-5">
              <span className="text-2xl font-bold">
                {plan.amount === 0
                  ? 'Free'
                  : `₦${plan.amount.toLocaleString()}`}
              </span>
              {plan.amount > 0 && (
                <span className="text-zinc-500 text-xs">/mo</span>
              )}
            </div>

            <div className="space-y-2 text-xs text-zinc-400 mb-5">
              <div className="flex items-center gap-2">
                <span style={{ color: '#818CF8' }}>✓</span>
                {plan.events.toLocaleString()} events/mo
              </div>
              <div className="flex items-center gap-2">
                <span style={{ color: '#818CF8' }}>✓</span>
                {formatRetention(plan.retention_hours)} retention
              </div>
              <div className="flex items-center gap-2">
                <span style={{ color: '#818CF8' }}>✓</span>
                {key === 'free'
                  ? '2 endpoints'
                  : key === 'starter'
                    ? '5 endpoints'
                    : 'Unlimited'}
              </div>
              <div className="flex items-center gap-2">
                <span style={{ color: key === 'free' ? '#52525b' : '#818CF8' }}>
                  {key === 'free' ? '✗' : '✓'}
                </span>
                <span className={key === 'free' ? 'text-zinc-600' : ''}>
                  AI features
                </span>
              </div>
            </div>

            {/* Button logic */}
            {currentPlan === key ? (
              <div
                className="text-center text-xs py-2 rounded-xl"
                style={{ background: 'rgba(79,70,229,0.15)', color: '#818CF8' }}
              >
                Current plan
              </div>
            ) : key === 'free' ? (
              <div
                className="text-center text-xs py-2 rounded-xl border"
                style={{
                  borderColor: 'rgba(255,255,255,0.08)',
                  color: '#52525b',
                }}
              >
                Downgrade
              </div>
            ) : paymentMode === 'test' ? (
              <a
                href="mailto:hello@hookdrop.dev?subject=Early Access Pro Plan&body=Hi, I would like to claim my free Pro plan. My account email is: "
                className="block text-center text-xs font-medium py-2 rounded-xl text-white transition-all hover:opacity-90"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Claim free early access
              </a>
            ) : (
              <button
                onClick={() => handleUpgrade(key)}
                disabled={loading}
                className="w-full text-xs font-medium py-2 rounded-xl text-white transition-all hover:opacity-90 disabled:opacity-50"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                {loading ? 'Redirecting...' : `Upgrade to ${plan.name}`}
              </button>
            )}
          </div>
        ))}
      </div>

      {paymentMode === 'live' && (
        <p className="text-xs text-zinc-600 mt-6 text-center">
          Payments powered by Paystack. Cancel anytime.
        </p>
      )}
    </div>
  )
}
