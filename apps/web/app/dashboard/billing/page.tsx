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

export default function BillingPage() {
  const { user } = useAuthStore()
  const [plans, setPlans] = useState<Plans>({})
  const [currentPlan, setCurrentPlan] = useState<string>('free')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.get('/api/billing/plans').then((res) => setPlans(res.data.plans))
    api
      .get('/api/billing/current')
      .then((res) => setCurrentPlan(res.data.current_plan))
  }, [])

  const handleUpgrade = async (plan: string) => {
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
    <div className="max-w-5xl">
      <h1 className="text-2xl font-semibold mb-2">Billing</h1>
      <p className="text-sm text-zinc-500 mb-8">
        You are currently on the{' '}
        <span className="text-white capitalize">{currentPlan}</span> plan.
      </p>

      <div className="grid grid-cols-4 gap-4">
        {Object.entries(plans).map(([key, plan]) => (
          <div
            key={key}
            className={`bg-zinc-900 rounded-xl p-6 border ${
              currentPlan === key ? 'border-white' : 'border-zinc-800'
            }`}
          >
            {currentPlan === key && (
              <div className="text-xs bg-white text-black px-2 py-0.5 rounded-full inline-block mb-3">
                Current plan
              </div>
            )}
            <h2 className="font-semibold text-lg mb-1">{plan.name}</h2>
            <p className="text-2xl font-bold mb-4">
              {plan.amount === 0
                ? 'Free'
                : `₦${plan.amount.toLocaleString()}/mo`}
            </p>

            <div className="space-y-2 text-sm text-zinc-400 mb-6">
              <div className="flex justify-between">
                <span>Events/month</span>
                <span className="text-white">
                  {plan.events.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Retention</span>
                <span className="text-white">
                  {formatRetention(plan.retention_hours)}
                </span>
              </div>
            </div>

            {currentPlan !== key && key !== 'free' && (
              <button
                onClick={() => handleUpgrade(key)}
                disabled={loading}
                className="w-full bg-white text-black py-2 rounded-lg text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-50"
              >
                {loading ? 'Redirecting...' : `Upgrade to ${plan.name}`}
              </button>
            )}

            {currentPlan !== key && key === 'free' && (
              <button
                disabled
                className="w-full border border-zinc-700 text-zinc-500 py-2 rounded-lg text-sm"
              >
                Downgrade
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
