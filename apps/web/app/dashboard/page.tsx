'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import Link from 'next/link'

interface Endpoint {
  id: string
  name: string
  public_token: string
  is_active: boolean
  created_at: string
}

export default function DashboardPage() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const fetchEndpoints = async () => {
    try {
      const res = await api.get('/api/endpoints')
      setEndpoints(res.data.endpoints)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEndpoints()
  }, [])

  const createEndpoint = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    setCreating(true)
    try {
      await api.post('/api/endpoints', { name: newName })
      setNewName('')
      setShowForm(false)
      fetchEndpoints()
    } catch (err) {
      console.error(err)
    } finally {
      setCreating(false)
    }
  }

  const deleteEndpoint = async (id: string) => {
    if (!confirm('Delete this endpoint and all its events?')) return
    try {
      await api.delete(`/api/endpoints/${id}`)
      fetchEndpoints()
    } catch (err) {
      console.error(err)
    }
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const ingestionUrl =
    process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:3002'

  return (
    <div>
      <div className="flex items-center justify-between mb-6 md:mb-8">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">Endpoints</h1>
          <p className="text-xs md:text-sm text-zinc-500 mt-1">
            Each endpoint has a unique capture URL
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs md:text-sm font-medium px-3 md:px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
          style={{
            background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
          }}
        >
          + New endpoint
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={createEndpoint}
          className="rounded-2xl border border-white/5 p-4 mb-4 flex flex-col sm:flex-row gap-3"
          style={{ background: 'rgba(255,255,255,0.02)' }}
        >
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Stripe payments"
            className="flex-1 rounded-xl px-4 py-2.5 text-sm focus:outline-none"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#f9fafb',
            }}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={creating}
              className="flex-1 sm:flex-none text-sm font-medium px-5 py-2.5 rounded-xl text-white disabled:opacity-50"
              style={{
                background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
              }}
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="text-sm text-zinc-500 hover:text-white px-3 py-2.5 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-zinc-500 text-sm">Loading...</p>
      ) : endpoints.length === 0 ? (
        <div
          className="text-center py-16 md:py-24 rounded-2xl border border-dashed"
          style={{ borderColor: 'rgba(255,255,255,0.06)' }}
        >
          <p className="text-zinc-500 text-sm mb-3">No endpoints yet</p>
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Create your first endpoint →
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="rounded-2xl border p-4 md:p-5 transition-colors"
              style={{
                background: 'rgba(255,255,255,0.02)',
                borderColor: 'rgba(255,255,255,0.06)',
              }}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-medium text-sm">{endpoint.name}</h3>
                  <span
                    className="text-xs px-2 py-0.5 rounded-full"
                    style={{
                      background: endpoint.is_active
                        ? 'rgba(34,197,94,0.1)'
                        : 'rgba(255,255,255,0.05)',
                      color: endpoint.is_active ? '#4ade80' : '#71717a',
                      border: `1px solid ${endpoint.is_active ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.06)'}`,
                    }}
                  >
                    {endpoint.is_active ? 'active' : 'inactive'}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    href={`/dashboard/endpoints/${endpoint.id}`}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors whitespace-nowrap"
                  >
                    View events →
                  </Link>
                  <button
                    onClick={() => deleteEndpoint(endpoint.id)}
                    className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code
                  className="text-xs text-zinc-400 rounded-lg px-3 py-2 flex-1 truncate"
                  style={{ background: 'rgba(255,255,255,0.04)' }}
                >
                  {ingestionUrl}/in/{endpoint.public_token}
                </code>
                <button
                  onClick={() =>
                    copyToClipboard(
                      `${ingestionUrl}/in/${endpoint.public_token}`,
                      endpoint.id
                    )
                  }
                  className="text-xs px-3 py-2 rounded-lg shrink-0 transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    color: copied === endpoint.id ? '#4ade80' : '#71717a',
                  }}
                >
                  {copied === endpoint.id ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
