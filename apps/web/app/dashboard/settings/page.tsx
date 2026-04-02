'use client'

import { useState } from 'react'
import { useAuthStore } from '@/lib/auth'

export default function SettingsPage() {
  const { user, logout, planLoading } = useAuthStore()
  const [copied, setCopied] = useState(false)

  const copyToken = () => {
    const token = localStorage.getItem('hookdrop_token')
    if (token) {
      navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const PLAN_DETAILS: Record<string, { events: string; retention: string; endpoints: string }> = {
    free:    { events: '500/month',     retention: '24 hours', endpoints: '2' },
    starter: { events: '10,000/month',  retention: '7 days',   endpoints: '5' },
    pro:     { events: '100,000/month', retention: '30 days',  endpoints: 'Unlimited' },
    team:    { events: '500,000/month', retention: '90 days',  endpoints: 'Unlimited' },
  }

  const currentPlan = user?.plan || 'free'
  const planDetails = PLAN_DETAILS[currentPlan] || PLAN_DETAILS.free

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">Settings</h1>
      <p className="text-sm text-zinc-500 mb-8">Manage your account and API access</p>

      <div className="rounded-2xl border border-white/5 p-6 mb-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <h2 className="text-sm font-medium mb-4">Account</h2>
        <div className="space-y-3">
          <div className="flex justify-between items-center py-2 border-b border-white/5">
            <span className="text-sm text-zinc-400">Name</span>
            <span className="text-sm">{user?.name}</span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-white/5">
            <span className="text-sm text-zinc-400">Email</span>
            <span className="text-sm">{user?.email}</span>
          </div>
          <div className="flex justify-between items-center py-2">
            <span className="text-sm text-zinc-400">Plan</span>
            {planLoading ? (
              <span className="text-xs text-zinc-500 animate-pulse">Refreshing...</span>
            ) : (
              <span
                className="text-xs px-3 py-1 rounded-full font-medium capitalize"
                style={{ background: 'rgba(79,70,229,0.15)', color: '#818CF8', border: '1px solid rgba(79,70,229,0.3)' }}
              >
                {currentPlan}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/5 p-6 mb-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <h2 className="text-sm font-medium mb-1">API token</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Use this to authenticate direct API requests.
        </p>
        <button
          onClick={copyToken}
          className="text-sm border border-white/10 hover:border-white/20 px-4 py-2 rounded-xl transition-colors"
        >
          {copied ? '✓ Copied!' : 'Copy API token'}
        </button>
      </div>

      <div className="rounded-2xl border border-white/5 p-6 mb-4" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <h2 className="text-sm font-medium mb-1">Plan limits</h2>
        <p className="text-xs text-zinc-500 mb-4">
          You are on the <span className="text-white capitalize">{currentPlan}</span> plan.
        </p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between py-1.5 border-b border-white/5">
            <span className="text-zinc-400">Events per month</span>
            <span>{planDetails.events}</span>
          </div>
          <div className="flex justify-between py-1.5 border-b border-white/5">
            <span className="text-zinc-400">Event retention</span>
            <span>{planDetails.retention}</span>
          </div>
          <div className="flex justify-between py-1.5">
            <span className="text-zinc-400">Endpoints</span>
            <span>{planDetails.endpoints}</span>
          </div>
        </div>
        {currentPlan === 'free' && (
          <div className="mt-4 p-4 rounded-xl" style={{ background: 'rgba(79,70,229,0.08)', border: '1px solid rgba(79,70,229,0.2)' }}>
            <p className="text-xs text-zinc-400 mb-3">
              Upgrade to unlock AI features, more events, and longer retention.
            </p>
            
              href="/dashboard/billing"
              className="inline-block text-xs font-medium px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
            >
              Upgrade plan →
            </a>
          </div>
        )}
      </div>

      <div className="rounded-2xl border p-6" style={{ borderColor: 'rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.03)' }}>
        <h2 className="text-sm font-medium text-red-400 mb-1">Danger zone</h2>
        <p className="text-xs text-zinc-500 mb-4">These actions are irreversible.</p>
        <button
          onClick={logout}
          className="text-sm border border-white/10 hover:border-red-500/50 hover:text-red-400 px-4 py-2 rounded-xl transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
