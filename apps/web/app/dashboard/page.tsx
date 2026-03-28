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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  const ingestionUrl = process.env.NEXT_PUBLIC_INGESTION_URL || 'http://localhost:3002'

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold">Endpoints</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Each endpoint has a unique capture URL for your webhooks
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-white text-black px-4 py-2 rounded-lg text-sm font-medium hover:bg-zinc-200 transition-colors"
        >
          + New endpoint
        </button>
      </div>

      {showForm && (
        <form onSubmit={createEndpoint} className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 mb-6 flex gap-4">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Endpoint name e.g. Stripe payments"
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-zinc-500 transition-colors"
            autoFocus
          />
          <button
            type="submit"
            disabled={creating}
            className="bg-white text-black px-6 py-2.5 rounded-lg text-sm font-medium hover:bg-zinc-200 transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create'}
          </button>
          <button
            type="button"
            onClick={() => setShowForm(false)}
            className="text-sm text-zinc-500 hover:text-white transition-colors px-2"
          >
            Cancel
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading endpoints...</div>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-zinc-800 rounded-xl">
          <p className="text-zinc-500 mb-4">No endpoints yet</p>
          <button
            onClick={() => setShowForm(true)}
            className="text-sm text-white underline"
          >
            Create your first endpoint
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex items-center justify-between hover:border-zinc-700 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="font-medium text-sm">{endpoint.name}</h3>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    endpoint.is_active
                      ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                      : 'bg-zinc-800 text-zinc-500'
                  }`}>
                    {endpoint.is_active ? 'active' : 'inactive'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <code className="text-xs text-zinc-400 bg-zinc-800 px-3 py-1.5 rounded-lg truncate max-w-lg">
                    {ingestionUrl}/in/{endpoint.public_token}
                  </code>
                  <button
                    onClick={() => copyToClipboard(`${ingestionUrl}/in/${endpoint.public_token}`)}
                    className="text-xs text-zinc-500 hover:text-white transition-colors"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-3 ml-4">
                <Link
                  href={`/dashboard/endpoints/${endpoint.id}`}
                  className="text-sm text-zinc-400 hover:text-white transition-colors"
                >
                  View events →
                </Link>
                <button
                  onClick={() => deleteEndpoint(endpoint.id)}
                  className="text-sm text-zinc-600 hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
