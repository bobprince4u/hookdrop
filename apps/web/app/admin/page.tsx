'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

interface Stats {
  total_users: number
  free_users: number
  pro_users: number
  total_events: number
  total_endpoints: number
  events_today: number
}

export default function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/api/admin/stats')
      .then(res => setStats(res.data))
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="min-h-screen bg-zinc-950 text-white p-8">
      <p className="text-zinc-500">Loading stats...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-8">
      <h1 className="text-2xl font-semibold mb-8">Hookdrop Admin</h1>

      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { label: 'Total users', value: stats?.total_users },
          { label: 'Free users', value: stats?.free_users },
          { label: 'Pro users', value: stats?.pro_users },
          { label: 'Total events', value: stats?.total_events },
          { label: 'Total endpoints', value: stats?.total_endpoints },
          { label: 'Events today', value: stats?.events_today },
        ].map((stat) => (
          <div key={stat.label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className="text-xs text-zinc-500 mb-1">{stat.label}</p>
            <p className="text-3xl font-semibold">{stat.value ?? 0}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
