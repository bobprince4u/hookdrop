'use client'

import { useEffect, useState, useCallback } from 'react'
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

interface Rates {
  [currency: string]: number
}

const CURRENCIES = [
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', flag: '🇳🇬' },
  { code: 'USD', symbol: '$', name: 'US Dollar', flag: '🇺🇸' },
  { code: 'EUR', symbol: '€', name: 'Euro', flag: '🇪🇺' },
  { code: 'GBP', symbol: '£', name: 'British Pound', flag: '🇬🇧' },
]

declare global {
  interface Window {
    FlutterwaveCheckout: (config: Record<string, unknown>) => void
  }
}

export default function BillingPage() {
  const { user } = useAuthStore()
  const [plans, setPlans] = useState<Plans>({})
  const [currentPlan, setCurrentPlan] = useState<string>('free')
  const [paymentMode, setPaymentMode] = useState<'test' | 'live'>('test')
  const [selectedCurrency, setSelectedCurrency] = useState('NGN')
  const [rates, setRates] = useState<Rates>({
    NGN: 1,
    USD: 1600,
    EUR: 1750,
    GBP: 2050,
  })
  const [ratesLoading, setRatesLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [upgradingPlan, setUpgradingPlan] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState('')

  const fetchRates = useCallback(async () => {
    setRatesLoading(true)
    try {
      const res = await api.get('/api/billing/rates')
      setRates(res.data.rates)
    } catch {
      // keep fallback rates
    } finally {
      setRatesLoading(false)
    }
  }, [])

  useEffect(() => {
    api.get('/api/billing/plans').then((res) => setPlans(res.data.plans))
    api
      .get('/api/billing/current')
      .then((res) => setCurrentPlan(res.data.current_plan))
    api.get('/api/billing/mode').then((res) => setPaymentMode(res.data.mode))
    fetchRates()
  }, [fetchRates])

  const convertPrice = (ngnAmount: number): number => {
    if (selectedCurrency === 'NGN') return ngnAmount
    const rate = rates[selectedCurrency] || 1
    return Math.round((ngnAmount / rate) * 100) / 100
  }

  const formatPrice = (ngnAmount: number): string => {
    const converted = convertPrice(ngnAmount)
    const currency = CURRENCIES.find((c) => c.code === selectedCurrency)
    if (selectedCurrency === 'NGN') return `₦${ngnAmount.toLocaleString()}`
    return `${currency?.symbol}${converted.toFixed(2)}`
  }

  const handleFlutterwaveCheckout = async (planKey: string) => {
    if (paymentMode === 'test') return
    if (!user) return

    setLoading(true)
    setUpgradingPlan(planKey)
    setUpgradeError('')

    try {
      const plan = plans[planKey]
      const amount = convertPrice(plan.amount)
      const txRef = `hookdrop-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      if (typeof window.FlutterwaveCheckout === 'undefined') {
        const res = await api.post('/api/billing/initialize', {
          plan: planKey,
          provider: 'flutterwave',
          currency: selectedCurrency,
        })
        window.location.href = res.data.authorization_url
        return
      }

      window.FlutterwaveCheckout({
        public_key: process.env.NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY,
        tx_ref: txRef,
        amount,
        currency: selectedCurrency,
        customer: { email: user.email, name: user.name },
        meta: { user_id: user.id, plan: planKey, provider: 'flutterwave' },
        customizations: {
          title: 'Hookdrop',
          description: `Upgrade to ${plan.name} plan`,
          logo: 'https://hookdropi.vercel.app/hookdroplogo.png',
        },
        callback: async (response: {
          status: string
          transaction_id: string
        }) => {
          if (response.status === 'successful') {
            await api.post('/api/billing/verify-flutterwave', {
              transaction_id: response.transaction_id,
              plan: planKey,
            })
            window.location.href =
              '/dashboard/billing/success?reference=' + txRef
          }
        },
        onclose: () => {
          setLoading(false)
          setUpgradingPlan(null)
        },
      })
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } }
      setUpgradeError(
        error.response?.data?.error || 'Payment initialization failed.'
      )
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
                Paid plans are not yet active. The first 20 developers get 3
                months of Pro absolutely free.
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

      {/* Currency selector — always visible */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium">Select currency</p>
          {ratesLoading ? (
            <span className="text-xs text-zinc-500 animate-pulse">
              Fetching live rates...
            </span>
          ) : (
            <button
              onClick={fetchRates}
              className="text-xs text-zinc-500 hover:text-white transition-colors"
            >
              Refresh rates ↻
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {CURRENCIES.map((c) => (
            <button
              key={c.code}
              onClick={() => setSelectedCurrency(c.code)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all"
              style={{
                background:
                  selectedCurrency === c.code
                    ? 'rgba(79,70,229,0.15)'
                    : 'rgba(255,255,255,0.02)',
                borderColor:
                  selectedCurrency === c.code
                    ? 'rgba(79,70,229,0.4)'
                    : 'rgba(255,255,255,0.08)',
                color: selectedCurrency === c.code ? '#818CF8' : '#a1a1aa',
              }}
            >
              <span>{c.flag}</span>
              <span className="font-medium text-xs">{c.code}</span>
              <span className="text-xs opacity-60">{c.symbol}</span>
            </button>
          ))}
        </div>
        {selectedCurrency !== 'NGN' && !ratesLoading && (
          <p className="text-xs text-zinc-600 mt-2">
            Live rate: 1 {selectedCurrency} = ₦
            {rates[selectedCurrency]?.toLocaleString()} NGN
          </p>
        )}
      </div>

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
            <div className="flex items-baseline gap-0.5 mb-1">
              <span className="text-xl font-bold">
                {plan.amount === 0 ? 'Free' : formatPrice(plan.amount)}
              </span>
              {plan.amount > 0 && (
                <span className="text-zinc-500 text-xs">/mo</span>
              )}
            </div>
            {plan.amount > 0 && selectedCurrency !== 'NGN' && (
              <p className="text-xs text-zinc-600 mb-2">
                ₦{plan.amount.toLocaleString()} NGN
              </p>
            )}
            <div
              className={
                plan.amount > 0 && selectedCurrency !== 'NGN' ? 'mb-3' : 'mb-4'
              }
            />

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
                onClick={() => handleFlutterwaveCheckout(key)}
                disabled={loading}
                className="w-full text-xs font-medium py-2 rounded-xl text-white transition-all hover:opacity-90 disabled:opacity-50"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                {upgradingPlan === key
                  ? 'Loading...'
                  : `Pay ${formatPrice(plan.amount)}`}
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
          Powered by Flutterwave. Accepts cards, bank transfer, mobile money.
          Cancel anytime.
        </p>
      )}

      <div
        className="mt-6 p-4 rounded-xl border border-white/5"
        style={{ background: 'rgba(255,255,255,0.01)' }}
      >
        <p className="text-xs text-zinc-500 mb-2 font-medium">
          Accepted payment methods
        </p>
        <div className="flex flex-col gap-2 text-xs text-zinc-500">
          <span>
            🇳🇬 <span className="text-zinc-400 font-medium">Paystack</span> —
            Cards, Bank Transfer, USSD (Nigeria)
          </span>
          <span>
            🌍 <span className="text-zinc-400 font-medium">Flutterwave</span> —
            Cards, Mobile Money, Bank Transfer (Africa + International)
          </span>
        </div>
      </div>
    </div>
  )
}
