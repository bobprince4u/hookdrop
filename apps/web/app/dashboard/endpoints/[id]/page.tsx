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
  const [activeTab, setActiveTab] = useState<'payload' | 'headers' | 'ai'>(
    'payload'
  )
  const [aiLoading, setAiLoading] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [schema, setSchema] = useState('')
  const [handler, setHandler] = useState('')
  const [language, setLanguage] = useState('typescript')
  const [framework, setFramework] = useState('express')

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

  useEffect(() => {
    if (!endpoint) return
    const socket = io(
      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3003'
    )
    socket.on('connect', () => {
      socket.emit('join', endpoint.public_token)
      setLive(true)
    })
    socket.on('new_event', (event: Event) =>
      setEvents((prev) => [event, ...prev])
    )
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

  const selectEvent = (event: Event) => {
    setSelected(event)
    setActiveTab('payload')
    setExplanation('')
    setSchema('')
    setHandler('')
  }

  const loadExplanation = async () => {
    if (!selected || explanation) return
    setAiLoading(true)
    try {
      const res = await api.get(
        `/api/endpoints/${id}/events/${selected.id}/ai/explain`
      )
      setExplanation(res.data.explanation)
    } catch (err) {
      setExplanation('AI quota exceeded. Please try again in a few minutes.')
      console.error(err)
    } finally {
      setAiLoading(false)
    }
  }
  const loadSchema = async () => {
    if (!selected || schema) return
    setAiLoading(true)
    try {
      const res = await api.get(
        `/api/endpoints/${id}/events/${selected.id}/ai/schema`
      )
      setSchema(res.data.schema)
    } catch (err) {
      console.error(err)
    } finally {
      setAiLoading(false)
    }
  }

  const loadHandler = async () => {
    if (!selected) return
    setAiLoading(true)
    try {
      const res = await api.post(
        `/api/endpoints/${id}/events/${selected.id}/ai/handler`,
        {
          language,
          framework,
        }
      )
      setHandler(res.data.handler)
    } catch (err) {
      console.error(err)
    } finally {
      setAiLoading(false)
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
        <Link
          href="/dashboard"
          className="text-zinc-500 hover:text-white text-sm transition-colors"
        >
          ← Endpoints
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {endpoint?.name || 'Loading...'}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <code className="text-xs text-zinc-500">
              {process.env.NEXT_PUBLIC_INGESTION_URL}/in/
              {endpoint?.public_token}
            </code>
            <span
              className={`text-xs px-2 py-0.5 rounded-full border ${
                live
                  ? 'bg-green-500/10 text-green-400 border-green-500/20'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}
            >
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
        <div className="space-y-2">
          {loading ? (
            <p className="text-zinc-500 text-sm">Loading events...</p>
          ) : events.length === 0 ? (
            <div className="text-center py-16 border border-dashed border-zinc-800 rounded-xl">
              <p className="text-zinc-500 text-sm mb-2">No events yet</p>
              <p className="text-zinc-600 text-xs">
                Send a webhook to your capture URL
              </p>
            </div>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                onClick={() => selectEvent(event)}
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
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full border ${statusColor[event.status] || 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}
                    >
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

        <div>
          {selected ? (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 sticky top-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-1">
                  {(['payload', 'headers', 'ai'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => {
                        setActiveTab(tab)
                        if (tab === 'ai') loadExplanation()
                      }}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors capitalize ${
                        activeTab === tab
                          ? 'bg-zinc-700 text-white'
                          : 'text-zinc-500 hover:text-white'
                      }`}
                    >
                      {tab === 'ai' ? '✦ AI' : tab}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => replayEvent(selected.id)}
                  disabled={replaying}
                  className="text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                >
                  {replaying ? 'Replaying...' : '↺ Replay'}
                </button>
              </div>

              {activeTab === 'payload' && (
                <div className="space-y-3">
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
                    <p className="text-xs text-zinc-300">
                      {selected.source_ip}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">Payload</p>
                    <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-72 leading-relaxed">
                      {formatBody(selected.body)}
                    </pre>
                  </div>
                </div>
              )}

              {activeTab === 'headers' && (
                <div>
                  <p className="text-xs text-zinc-500 mb-2">Request headers</p>
                  <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-96 leading-relaxed">
                    {JSON.stringify(selected.headers, null, 2)}
                  </pre>
                </div>
              )}

              {activeTab === 'ai' && (
                <div className="space-y-5">
                  {/* Explanation */}
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">
                      ✦ Plain English explanation
                    </p>
                    {aiLoading && !explanation ? (
                      <p className="text-xs text-zinc-500 animate-pulse">
                        Asking AI...
                      </p>
                    ) : explanation ? (
                      <p className="text-xs text-zinc-300 leading-relaxed bg-zinc-800 rounded-lg p-3">
                        {explanation}
                      </p>
                    ) : null}
                  </div>

                  {/* Schema */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-zinc-500">
                        TypeScript interface
                      </p>
                      {!schema && (
                        <button
                          onClick={loadSchema}
                          disabled={aiLoading}
                          className="text-xs text-zinc-400 hover:text-white transition-colors"
                        >
                          Generate →
                        </button>
                      )}
                    </div>
                    {schema && (
                      <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-48 leading-relaxed">
                        {schema}
                      </pre>
                    )}
                  </div>

                  {/* Handler */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs text-zinc-500">Handler code</p>
                    </div>
                    <div className="flex gap-2 mb-2">
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
                      >
                        <option value="typescript">TypeScript</option>
                        <option value="javascript">JavaScript</option>
                        <option value="python">Python</option>
                        <option value="go">Go</option>
                      </select>
                      <select
                        value={framework}
                        onChange={(e) => setFramework(e.target.value)}
                        className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
                      >
                        <option value="express">Express</option>
                        <option value="fastify">Fastify</option>
                        <option value="nextjs">Next.js</option>
                        <option value="fastapi">FastAPI</option>
                        <option value="gin">Gin</option>
                      </select>
                      <button
                        onClick={loadHandler}
                        disabled={aiLoading}
                        className="text-xs bg-zinc-700 hover:bg-zinc-600 px-3 py-1 rounded transition-colors disabled:opacity-50"
                      >
                        {aiLoading ? 'Generating...' : 'Generate'}
                      </button>
                    </div>
                    {handler && (
                      <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-3 overflow-auto max-h-64 leading-relaxed">
                        {handler}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="border border-dashed border-zinc-800 rounded-xl p-8 text-center">
              <p className="text-zinc-600 text-sm">
                Select an event to inspect
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
