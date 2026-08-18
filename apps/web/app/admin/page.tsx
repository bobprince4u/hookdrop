'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, describeApiError } from '@/lib/api'
import { rehydrateAuth, useAuthStore } from '@/lib/auth'
import { useRouter } from 'next/navigation'

interface User {
  id: string
  name: string
  email: string
  plan: string
  payment_provider: string
  created_at: string
  plan_expires_at: string | null
  endpoint_count: number
  event_count: number
}

interface Pagination {
  page: number
  limit: number
  total: number
  pages: number
}

interface Stats {
  total_users: number
  free_users: number
  starter_users: number
  pro_users: number
  team_users: number
  total_events: number
  total_endpoints: number
  events_today: number
  total_deliveries: number
  failed_deliveries: number
}

const PLAN_COLORS: Record<string, string> = {
  free: 'rgba(255,255,255,0.06)',
  starter: 'rgba(59,130,246,0.15)',
  pro: 'rgba(79,70,229,0.15)',
  team: 'rgba(34,197,94,0.15)',
}

const PLAN_TEXT: Record<string, string> = {
  free: '#71717a',
  starter: '#60a5fa',
  pro: '#818CF8',
  team: '#4ade80',
}

/** Matches `paginationSchema`'s ceiling in the API service. */
const PAGE_SIZE = 50

/** Long enough that typing does not issue a query per keystroke. */
const SEARCH_DEBOUNCE_MS = 300

export default function AdminPage() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [stats, setStats] = useState<Stats | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [planFilter, setPlanFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [upgradeEmail, setUpgradeEmail] = useState('')
  const [upgradePlan, setUpgradePlan] = useState('pro')
  const [upgradeResult, setUpgradeResult] = useState('')
  const [showUpgradeForm, setShowUpgradeForm] = useState(false)

  /**
   * This page sits outside `dashboard/layout.tsx`, so nothing else restores the session
   * for it. The access token lives in memory now (H-16), which means a direct load of
   * `/admin` starts with no credential at all and `user` would stay null — the header
   * would read "Logged in as" with nothing after it.
   */
  useEffect(() => {
    void rehydrateAuth()
  }, [])

  /**
   * The API answers 401 for "not signed in" and 403 for "signed in but not an admin",
   * and both mean the same thing here: this page is not for you.
   *
   * A 401 is worth one refresh attempt first — the response interceptor in `lib/api.ts`
   * makes that attempt and retries transparently — so by the time a 401 surfaces here the
   * session is genuinely gone.
   */
  const handleLoadError = useCallback(
    (err: unknown, context: string): void => {
      const status =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined

      /**
       * The old handler logged the axios error object and then `console.log`'d
       * `err.response.data` verbatim (H-48). An admin error body quotes the query that
       * failed, and the error object carries the request's `Authorization` header.
       */
      console.error(`${context}:`, describeApiError(err))

      if (status === 401 || status === 403) {
        router.push('/dashboard')
        return
      }

      setError(describeApiError(err))
    },
    [router]
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  /**
   * Filtering moved to the server (H-33).
   *
   * `/api/admin/users` is paginated now, so the previous `users.filter(...)` searched
   * only whatever page happened to be loaded and reported its length as the user count —
   * a search for an address on page 3 returned "No users found".
   */
  const loadUsers = useCallback(async () => {
    try {
      const res = await api.get('/api/admin/users', {
        params: {
          page,
          limit: PAGE_SIZE,
          ...(planFilter === 'all' ? {} : { plan: planFilter }),
          ...(debouncedSearch ? { search: debouncedSearch } : {}),
        },
      })
      setUsers(Array.isArray(res.data?.users) ? res.data.users : [])
      setPagination(res.data?.pagination ?? null)
      setError(null)
    } catch (err) {
      handleLoadError(err, 'Admin users load failed')
    }
  }, [page, planFilter, debouncedSearch, handleLoadError])

  useEffect(() => {
    const load = async () => {
      try {
        const res = await api.get('/api/admin/stats')
        setStats(res.data)
      } catch (err) {
        handleLoadError(err, 'Admin stats load failed')
      }
    }
    void load()
  }, [handleLoadError])

  useEffect(() => {
    let active = true
    const load = async () => {
      await loadUsers()
      if (active) setLoading(false)
    }
    void load()
    return () => {
      active = false
    }
  }, [loadUsers])

  const handleManualUpgrade = async () => {
    if (!upgradeEmail || !upgradePlan) return
    setUpgrading(upgradeEmail)
    setUpgradeResult('')
    try {
      await api.post('/api/admin/upgrade-user', {
        email: upgradeEmail,
        plan: upgradePlan,
      })
      setUpgradeResult(`✓ ${upgradeEmail} upgraded to ${upgradePlan}`)
      setUpgradeEmail('')
      await loadUsers()
    } catch (err) {
      setUpgradeResult(`✗ ${describeApiError(err)}`)
    } finally {
      setUpgrading(null)
    }
  }

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: '#030712' }}
      >
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div
      className="min-h-screen px-4 md:px-8 py-8"
      style={{ background: '#030712' }}
    >
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Logged in as {user?.email}
            </p>
          </div>
          <a
            href="/dashboard"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            ← Back to dashboard
          </a>
        </div>

        {/* User stats */}
        {error && (
          <div
            className="text-sm px-4 py-3 rounded-xl border mb-4"
            style={{
              background: 'rgba(239,68,68,0.1)',
              borderColor: 'rgba(239,68,68,0.2)',
              color: '#f87171',
            }}
          >
            {error}
          </div>
        )}

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            {[
              {
                label: 'Total users',
                value: stats.total_users,
                color: '#818CF8',
              },
              { label: 'Free', value: stats.free_users, color: '#71717a' },
              {
                label: 'Starter',
                value: stats.starter_users,
                color: '#60a5fa',
              },
              { label: 'Pro', value: stats.pro_users, color: '#818CF8' },
              { label: 'Team', value: stats.team_users, color: '#4ade80' },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl p-4 border border-white/5"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <p className="text-xs text-zinc-500 mb-1">{stat.label}</p>
                <p
                  className="text-2xl font-semibold"
                  style={{ color: stat.color }}
                >
                  {stat.value}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* Event stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            {[
              {
                label: 'Total events',
                value: stats.total_events?.toLocaleString(),
              },
              {
                label: 'Events today',
                value: stats.events_today?.toLocaleString(),
              },
              {
                label: 'Total endpoints',
                value: stats.total_endpoints?.toLocaleString(),
              },
              {
                label: 'Failed deliveries',
                value: stats.failed_deliveries?.toLocaleString(),
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl p-4 border border-white/5"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <p className="text-xs text-zinc-500 mb-1">{stat.label}</p>
                <p className="text-xl font-semibold">{stat.value || 0}</p>
              </div>
            ))}
          </div>
        )}

        {/* Manual upgrade */}
        <div
          className="rounded-2xl border border-white/5 p-5 mb-6"
          style={{ background: 'rgba(255,255,255,0.02)' }}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-medium">Manual plan upgrade</h2>
            <button
              onClick={() => setShowUpgradeForm(!showUpgradeForm)}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {showUpgradeForm ? 'Hide' : 'Show'}
            </button>
          </div>
          {showUpgradeForm && (
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="email"
                value={upgradeEmail}
                onChange={(e) => setUpgradeEmail(e.target.value)}
                placeholder="user@example.com"
                className="flex-1 rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#f9fafb',
                }}
              />
              <select
                value={upgradePlan}
                onChange={(e) => setUpgradePlan(e.target.value)}
                className="rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#f9fafb',
                }}
              >
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="team">Team</option>
                <option value="free">Free</option>
              </select>
              <button
                onClick={handleManualUpgrade}
                disabled={!!upgrading}
                className="text-sm font-medium px-5 py-2.5 rounded-xl text-white disabled:opacity-50"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                {upgrading ? 'Upgrading...' : 'Upgrade'}
              </button>
            </div>
          )}
          {upgradeResult && (
            <p
              className={`text-xs mt-3 ${upgradeResult.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}
            >
              {upgradeResult}
            </p>
          )}
        </div>

        {/* Users table */}
        <div
          className="rounded-2xl border border-white/5 overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.02)' }}
        >
          <div className="p-5 border-b border-white/5 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <h2 className="text-sm font-medium">
              Users ({(pagination?.total ?? users.length).toLocaleString()})
            </h2>
            <div className="flex gap-2 flex-wrap">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or email..."
                maxLength={200}
                className="rounded-xl px-3 py-2 text-xs focus:outline-none w-48"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#f9fafb',
                }}
              />
              <select
                value={planFilter}
                onChange={(e) => {
                  setPlanFilter(e.target.value)
                  setPage(1)
                }}
                className="rounded-xl px-3 py-2 text-xs focus:outline-none"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#f9fafb',
                }}
              >
                <option value="all">All plans</option>
                <option value="free">Free</option>
                <option value="starter">Starter</option>
                <option value="pro">Pro</option>
                <option value="team">Team</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium">
                    User
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium">
                    Plan
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium hidden md:table-cell">
                    Provider
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium hidden md:table-cell">
                    Signed up
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium hidden lg:table-cell">
                    Expires
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium hidden lg:table-cell">
                    Endpoints
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium hidden lg:table-cell">
                    Events
                  </th>
                  <th className="text-left px-5 py-3 text-xs text-zinc-500 font-medium">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-8 text-center text-zinc-500 text-xs"
                    >
                      No users found
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-5 py-4">
                        <p className="text-sm font-medium">{u.name}</p>
                        <p className="text-xs text-zinc-500">{u.email}</p>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className="text-xs px-2.5 py-1 rounded-full font-medium capitalize"
                          style={{
                            background: PLAN_COLORS[u.plan] || PLAN_COLORS.free,
                            color: PLAN_TEXT[u.plan] || PLAN_TEXT.free,
                          }}
                        >
                          {u.plan}
                        </span>
                      </td>
                      <td className="px-5 py-4 hidden md:table-cell">
                        <span className="text-xs text-zinc-400 capitalize">
                          {u.payment_provider || '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 hidden md:table-cell">
                        <span className="text-xs text-zinc-400">
                          {new Date(u.created_at).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                        </span>
                      </td>
                      <td className="px-5 py-4 hidden lg:table-cell">
                        <span className="text-xs text-zinc-400">
                          {u.plan_expires_at
                            ? new Date(u.plan_expires_at).toLocaleDateString(
                                'en-GB',
                                {
                                  day: 'numeric',
                                  month: 'short',
                                  year: 'numeric',
                                }
                              )
                            : '—'}
                        </span>
                      </td>
                      <td className="px-5 py-4 hidden lg:table-cell">
                        <span className="text-xs text-zinc-400">
                          {u.endpoint_count || 0}
                        </span>
                      </td>
                      <td className="px-5 py-4 hidden lg:table-cell">
                        <span className="text-xs text-zinc-400">
                          {Number(u.event_count || 0).toLocaleString()}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <button
                          onClick={() => {
                            setUpgradeEmail(u.email)
                            setShowUpgradeForm(true)
                            window.scrollTo({ top: 0, behavior: 'smooth' })
                          }}
                          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          Upgrade
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {pagination && pagination.pages > 1 && (
            <div className="p-4 border-t border-white/5 flex items-center justify-between text-xs">
              <span className="text-zinc-500">
                Page {pagination.page} of {pagination.pages}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={pagination.page <= 1}
                  className="border border-white/10 hover:border-white/25 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  ← Previous
                </button>
                <button
                  onClick={() =>
                    setPage((p) => Math.min(pagination.pages, p + 1))
                  }
                  disabled={pagination.page >= pagination.pages}
                  className="border border-white/10 hover:border-white/25 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
