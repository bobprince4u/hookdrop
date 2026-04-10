'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/auth'

interface Plan {
  name: string
  amount: number
  events: number
  retention_hours: number
}

interface Plans {
  [key: string]: Plan
}

const PROVIDERS = [
  {
    id: 'paystack',
    name: 'Paystack',
    flag: '🇳🇬',
    desc: 'Best for Nigeria',
    currencies: 'NGN',
  },
  {
    id: 'flutterwave',
    name: 'Flutterwave',
    flag: '🌍',
    desc: 'Pan-Africa',
    currencies: 'NGN, GHS, KES, ZAR',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    flag: '🌐',
    desc: 'International',
    currencies: 'USD, EUR, GBP',
  },
]

export default function BillingPage() {
  const { user } = useAuthStore()
  const [plans, setPlans] = useState<Plans>({})
  const [currentPlan, setCurrentPlan] = useState<string>('free')
  const [paymentMode, setPaymentMode] = useState<'test' | 'live'>('test')
  const [selectedProvider, setSelectedProvider] = useState('paystack')
  const [loading, setLoading] = useState(false)
  const [upgradingPlan, setUpgradingPlan] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState('')

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
    setUpgradingPlan(plan)
    setUpgradeError('')
    try {
      const res = await api.post('/api/billing/initialize', {
        plan,
        provider: selectedProvider,
      })
      window.location.href = res.data.authorization_url
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } }
      setUpgradeError(
        error.response?.data?.error ||
          'Payment initialization failed. Please try again.'
      )
      console.error(err)
    } finally {
      setLoading(false)
      setUpgradingPlan(null)
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
      <h1 className="text-xl md:text-2xl font-semibold mb-2">Billing</h1>
      <p className="text-sm text-zinc-500 mb-6">
        You are on the{' '}
        <span className="text-white capitalize">{currentPlan}</span> plan.
      </p>

      {/* Early access banner */}
      {paymentMode === 'test' && (
        <div
          className="rounded-2xl p-4 md:p-5 mb-6 border"
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
                Paid plans are not yet active. As a thank you to early users,
                the first 20 developers get 3 months of Pro absolutely free.
              </p>
              <a
                href={`mailto:hello@hookdrop.dev?subject=Early Access Pro Plan&body=Hi, I would like to claim my free Pro plan. My account email is: ${user?.email}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Claim your free Pro plan →
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Provider selector — live mode only */}
      {paymentMode === 'live' && (
        <div className="mb-6">
          <p className="text-sm font-medium mb-3">Choose payment method</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
                className="flex items-center gap-3 p-3 rounded-xl border text-left transition-all"
                style={{
                  background:
                    selectedProvider === p.id
                      ? 'rgba(79,70,229,0.1)'
                      : 'rgba(255,255,255,0.02)',
                  borderColor:
                    selectedProvider === p.id
                      ? 'rgba(79,70,229,0.4)'
                      : 'rgba(255,255,255,0.08)',
                }}
              >
                <span className="text-xl">{p.flag}</span>
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-xs text-zinc-500">{p.desc}</p>
                  <p className="text-xs text-zinc-600">{p.currencies}</p>
                </div>
                {selectedProvider === p.id && (
                  <span
                    className="ml-auto text-xs"
                    style={{ color: '#818CF8' }}
                  >
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Plans grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        {Object.entries(plans).map(([key, plan]) => (
          <div
            key={key}
            className="rounded-2xl p-5 border transition-all relative"
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
                Current
              </div>
            )}

            <h3 className="font-semibold text-sm mb-1">{plan.name}</h3>
            <div className="flex items-baseline gap-0.5 mb-4">
              <span className="text-xl md:text-2xl font-bold">
                {plan.amount === 0
                  ? 'Free'
                  : `₦${plan.amount.toLocaleString()}`}
              </span>
              {plan.amount > 0 && (
                <span className="text-zinc-500 text-xs">/mo</span>
              )}
            </div>

            <div className="space-y-1.5 text-xs text-zinc-400 mb-5">
              <div className="flex items-center gap-2">
                <span style={{ color: '#818CF8' }}>✓</span>
                {plan.events.toLocaleString()} events
              </div>
              <div className="flex items-center gap-2">
                <span style={{ color: '#818CF8' }}>✓</span>
                {formatRetention(plan.retention_hours)}
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
                href={`mailto:hello@hookdrop.dev?subject=Early Access Pro Plan&body=Hi, I want the free Pro plan. My email: ${user?.email}`}
                className="block text-center text-xs font-medium py-2 rounded-xl text-white hover:opacity-90 transition-all"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Claim free access
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
                {upgradingPlan === key
                  ? 'Redirecting...'
                  : `Upgrade via ${PROVIDERS.find((p) => p.id === selectedProvider)?.name}`}
              </button>
            )}
          </div>
        ))}
      </div>

      {upgradeError && (
        <div
          className="mt-4 p-3 rounded-xl text-xs text-red-400 border"
          style={{
            background: 'rgba(239,68,68,0.1)',
            borderColor: 'rgba(239,68,68,0.2)',
          }}
        >
          {upgradeError}
        </div>
      )}

      {paymentMode === 'live' && (
        <p className="text-xs text-zinc-600 mt-4 text-center">
          Payments powered by{' '}
          {PROVIDERS.find((p) => p.id === selectedProvider)?.name}. Cancel
          anytime.
        </p>
      )}

      <div
        className="mt-6 p-4 rounded-xl border border-white/5"
        style={{ background: 'rgba(255,255,255,0.01)' }}
      >
        <p className="text-xs text-zinc-500 mb-2 font-medium">
          Accepted payment methods
        </p>
        <div className="flex flex-wrap gap-3 text-xs text-zinc-600">
          <span>🇳🇬 Paystack — Cards, Bank Transfer, USSD (Nigeria)</span>
          <span>🌍 Flutterwave — Cards, Mobile Money (Africa)</span>
          <span>🌐 Stripe — Cards, Apple Pay, Google Pay (Global)</span>
        </div>
      </div>
    </div>
  )
}
