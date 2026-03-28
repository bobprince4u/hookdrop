'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api'
import Link from 'next/link'
import { io } from 'socket.io-client'

interface Event {
  id: string
  method: string
  status: string
  source_ip: string
  received_at: string
  body: string
  headers: Record<string, string>
}

interface Endpoint {
  id: string
  name: string
  public_token: string
}

const statusColor: Record<string, string> = {
  received: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  delivered: 'bg-green-500/10 text-green-400 border-green-500/20',
  failed: 'bg-red-500/10 text-red-400 border-red-500/20',
  retrying: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  dead_letter: 'bg-red-500/10 text-red-400 border-red-500/20',
}

export default function EndpointEventsPage() {
  const { id } = useParams()
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [selected, setSelected] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [replaying, setReplaying] = useState(false)
  const [live, setLive] = useState(false)

  const fetchEndpoint = useCallback(async () => {
    try {
      const res = await api.get(`/api/endpoints/${id}`)
      setEndpoint(res.data.endpoint)
    } catch (err) {
      console.error(err)
    }
  }, [id])

  const fetchEvents = useCallback(async () => {
    try {
      const res = await api.get(`/api/endpoints/${id}/events`)
      setEvents(res.data.events)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    fetchEndpoint()
    fetchEvents()
  }, [fetchEndpoint, fetchEvents])

  // WebSocket live feed
  useEffect(() => {
    if (!endpoint) return

    const socket = io(
      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3003'
    )

    socket.on('connect', () => {
      socket.emit('join', endpoint.public_token)
      setLive(true)
    })

    socket.on('new_event', (event: Event) => {
      setEvents((prev) => [event, ...prev])
    })

    socket.on('disconnect', () => setLive(false))

    return () => {
      socket.disconnect()
    }
  }, [endpoint])

  const replayEvent = async (eventId: string) => {
    setReplaying(true)
    try {
      await api.post(`/api/endpoints/${id}/events/${eventId}/replay`)
      setTimeout(fetchEvents, 2000)
    } catch (err) {
      console.error(err)
    } finally {
      setReplaying(false)
    }
  }

  const formatBody = (body: string) => {
    try {
      return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      return body
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <Link href="/dashboard" className="text-zinc-500 hover:text-white text-sm transition-colors">
          ← Endpoints
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{endpoint?.name || 'Loading...'}</h1>
          <div className="flex items-center gap-2 mt-1">
            <code className="text-xs text-zinc-500">
              {process.env.NEXT_PUBLIC_INGESTION_URL}/in/{endpoint?.public_token}
            </code>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              live
                ? 'bg-green-500/10 text-green-400 border-green-500/20'
                : 'bg-zinc-800 text-zinc-500 border-zinc-700'
            }`}>
              {live ? '● live' : '○ connecting'}
            </span>
          </div>
        </div>
        <button
          onClick={fetchEvents}
          className="text-sm text-zinc-400 hover:text-white transition-colors border border-zinc-800 px-4 py-2 rounded-lg"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Events list */}
        <div className="space-y-2">
          {loading ? (
            <p className="text-zinc-500 text-sm">Loading events...</p>
          ) : events.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-zinc-800 rounded-xl">
              <p className="text-zinc-500 text-sm mb-2">No events yet</p>
              <p className="text-zinc-600 text-xs">
                Send a webhook to your capture URL to get started
              </p>
            </div>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                onClick={() => setSelected(event)}
                className={`bg-zinc-900 border rounded-xl p-4 cursor-pointer transition-colors ${
                  selected?.id === event.id
                    ? 'border-zinc-600'
                    : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-zinc-300">
                      {event.method}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      statusColor[event.status] || 'bg-zinc-800 text-zinc-400 border-zinc-700'
                    }`}>
                      {event.status}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-600">
                    {new Date(event.received_at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 truncate">
                  {event.body?.substring(0, 80)}
                </p>
              </div>
            ))
          )}
        </div>

        {/* Event detail */}
        <div>
          {selected ? (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 sticky top-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium">Event detail</h3>
                <button
                  onClick={() => replayEvent(selected.id)}
                  disabled={replaying}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {replaying ? 'Replaying...' : '↺ Replay'}
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Event ID</p>
                  <code className="text-xs text-zinc-300">{selected.id}</code>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Received at</p>
                  <p className="text-xs text-zinc-300">
                    {new Date(selected.received_at).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-1">Source IP</p>
                  <p className="text-xs text-zinc-300">{selected.source_ip}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-2">Payload</p>
                  <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-64 leading-relaxed">
                    {formatBody(selected.body)}
                  </pre>
                </div>
                <div>
                  <p className="text-xs text-zinc-500 mb-2">Headers</p>
                  <pre className="text-xs text-zinc-400 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-32 leading-relaxed">
                    {JSON.stringify(selected.headers, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            <div className="border border-dashed border-zinc-800 rounded-xl p-8 text-center">
              <p className="text-zinc-600 text-sm">Select an event to inspect</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
