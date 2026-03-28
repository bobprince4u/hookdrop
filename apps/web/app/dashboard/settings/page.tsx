'use client'

import { useState } from 'react'
import { useAuthStore } from '@/lib/auth'

export default function SettingsPage() {
  const { user, logout } = useAuthStore()
  const [copied, setCopied] = useState(false)

  const copyToken = () => {
    const token = localStorage.getItem('hookdrop_token')
    if (token) {
      navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-2">Settings</h1>
      <p className="text-sm text-zinc-500 mb-8">Manage your account and API access</p>

      {/* Account */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-4">
        <h2 className="text-sm font-medium mb-4">Account</h2>
        <div className="space-y-3">
          <div className="flex justify-between items-center py-2 border-b border-zinc-800">
            <span className="text-sm text-zinc-400">Name</span>
            <span className="text-sm">{user?.name}</span>
          </div>
          <div className="flex justify-between items-center py-2 border-b border-zinc-800">
            <span className="text-sm text-zinc-400">Email</span>
            <span className="text-sm">{user?.email}</span>
          </div>
          <div className="flex justify-between items-center py-2">
            <span className="text-sm text-zinc-400">Plan</span>
            <span className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 px-3 py-1 rounded-full capitalize">
              {user?.plan}
            </span>
          </div>
        </div>
      </div>

      {/* API Token */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-4">
        <h2 className="text-sm font-medium mb-1">API token</h2>
        <p className="text-xs text-zinc-500 mb-4">
          Use this token to authenticate requests to the Hookdrop API directly.
        </p>
        <button
          onClick={copyToken}
          className="text-sm border border-zinc-700 hover:border-zinc-500 px-4 py-2 rounded-lg transition-colors"
        >
          {copied ? 'Copied!' : 'Copy API token'}
        </button>
      </div>

      {/* Plan */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-4">
        <h2 className="text-sm font-medium mb-1">Plan limits</h2>
        <p className="text-xs text-zinc-500 mb-4">
          You are on the free plan.
        </p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between py-1.5 border-b border-zinc-800">
            <span className="text-zinc-400">Events per month</span>
            <span>500</span>
          </div>
          <div className="flex justify-between py-1.5 border-b border-zinc-800">
            <span className="text-zinc-400">Event retention</span>
            <span>24 hours</span>
          </div>
          <div className="flex justify-between py-1.5">
            <span className="text-zinc-400">Endpoints</span>
            <span>3</span>
          </div>
        </div>
        <div className="mt-4 p-4 bg-zinc-800 rounded-lg">
          <p className="text-xs text-zinc-400 mb-2">
            Upgrade to Pro for 100,000 events/month, 30-day retention, and unlimited endpoints.
          </p>
          <button className="text-xs bg-white text-black px-4 py-2 rounded-lg font-medium hover:bg-zinc-200 transition-colors">
            Upgrade to Pro — ₦19,000/mo
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="bg-zinc-900 border border-red-500/20 rounded-xl p-6">
        <h2 className="text-sm font-medium text-red-400 mb-1">Danger zone</h2>
        <p className="text-xs text-zinc-500 mb-4">
          These actions are irreversible.
        </p>
        <button
          onClick={logout}
          className="text-sm border border-zinc-700 hover:border-red-500/50 hover:text-red-400 px-4 py-2 rounded-lg transition-colors"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
