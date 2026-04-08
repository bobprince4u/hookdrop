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
  received: 'text-blue-400',
  delivered: 'text-green-400',
  failed: 'text-red-400',
  retrying: 'text-yellow-400',
  dead_letter: 'text-red-400',
}

const statusBg: Record<string, string> = {
  received: 'rgba(59,130,246,0.1)',
  delivered: 'rgba(34,197,94,0.1)',
  failed: 'rgba(239,68,68,0.1)',
  retrying: 'rgba(234,179,8,0.1)',
  dead_letter: 'rgba(239,68,68,0.1)',
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
  const [upgradeRequired, setUpgradeRequired] = useState(false)
  const [showDetail, setShowDetail] = useState(false)

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
    setUpgradeRequired(false)
    setShowDetail(true)
  }

  const handleAIError = (err: unknown) => {
    const error = err as {
      response?: { data?: { upgrade_required?: boolean } }
    }
    if (error.response?.data?.upgrade_required) setUpgradeRequired(true)
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
      handleAIError(err)
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
      handleAIError(err)
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
        { language, framework }
      )
      setHandler(res.data.handler)
    } catch (err) {
      handleAIError(err)
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

  const DetailPanel = () => (
    <div
      className="rounded-2xl border p-4 md:p-5"
      style={{
        background: 'rgba(255,255,255,0.02)',
        borderColor: 'rgba(255,255,255,0.06)',
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {(['payload', 'headers', 'ai'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => {
                setActiveTab(tab)
                if (tab === 'ai') loadExplanation()
              }}
              className="text-xs px-2.5 py-1.5 rounded-lg transition-colors capitalize"
              style={{
                background:
                  activeTab === tab ? 'rgba(79,70,229,0.2)' : 'transparent',
                color: activeTab === tab ? '#818CF8' : '#71717a',
              }}
            >
              {tab === 'ai' ? '✦ AI' : tab}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => replayEvent(selected!.id)}
            disabled={replaying}
            className="text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 border"
            style={{
              background: 'rgba(255,255,255,0.04)',
              borderColor: 'rgba(255,255,255,0.08)',
              color: '#a1a1aa',
            }}
          >
            {replaying ? 'Replaying...' : '↺ Replay'}
          </button>
          <button
            onClick={() => setShowDetail(false)}
            className="md:hidden text-xs text-zinc-500 hover:text-white px-2 py-1.5"
          >
            ✕
          </button>
        </div>
      </div>

      {activeTab === 'payload' && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Event ID</p>
            <code className="text-xs text-zinc-300 break-all">
              {selected!.id}
            </code>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Received at</p>
            <p className="text-xs text-zinc-300">
              {new Date(selected!.received_at).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Source IP</p>
            <p className="text-xs text-zinc-300">{selected!.source_ip}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-2">Payload</p>
            <pre
              className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-64 leading-relaxed"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            >
              {formatBody(selected!.body)}
            </pre>
          </div>
        </div>
      )}

      {activeTab === 'headers' && (
        <div>
          <p className="text-xs text-zinc-500 mb-2">Request headers</p>
          <pre
            className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-80 leading-relaxed"
            style={{ background: 'rgba(255,255,255,0.04)' }}
          >
            {JSON.stringify(selected!.headers, null, 2)}
          </pre>
        </div>
      )}

      {activeTab === 'ai' && (
        <div className="space-y-4">
          {upgradeRequired ? (
            <div
              className="text-center py-6 rounded-2xl border border-dashed"
              style={{
                borderColor: 'rgba(79,70,229,0.3)',
                background: 'rgba(79,70,229,0.05)',
              }}
            >
              <div className="text-xl mb-2">✦</div>
              <h3 className="font-medium text-sm mb-1">
                AI requires a paid plan
              </h3>
              <p className="text-xs text-zinc-500 mb-3">
                Upgrade to Starter or above to unlock AI features.
              </p>
              <Link
                href="/dashboard/billing"
                className="inline-block text-xs font-medium px-4 py-2 rounded-lg text-white"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                Upgrade plan →
              </Link>
            </div>
          ) : (
            <>
              <div>
                <p className="text-xs text-zinc-500 mb-2">
                  ✦ Plain English explanation
                </p>
                {aiLoading && !explanation ? (
                  <p className="text-xs text-zinc-500 animate-pulse">
                    Asking AI...
                  </p>
                ) : explanation ? (
                  <p
                    className="text-xs text-zinc-300 leading-relaxed rounded-xl p-3"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    {explanation}
                  </p>
                ) : null}
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-zinc-500">TypeScript interface</p>
                  {!schema && (
                    <button
                      onClick={loadSchema}
                      disabled={aiLoading}
                      className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      Generate →
                    </button>
                  )}
                </div>
                {schema && (
                  <pre
                    className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-40 leading-relaxed"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    {schema}
                  </pre>
                )}
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-2">Handler code</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    className="text-xs rounded-lg px-2 py-1"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#d4d4d8',
                    }}
                  >
                    <option value="typescript">TypeScript</option>
                    <option value="javascript">JavaScript</option>
                    <option value="python">Python</option>
                    <option value="go">Go</option>
                  </select>
                  <select
                    value={framework}
                    onChange={(e) => setFramework(e.target.value)}
                    className="text-xs rounded-lg px-2 py-1"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#d4d4d8',
                    }}
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
                    className="text-xs px-3 py-1 rounded-lg disabled:opacity-50"
                    style={{
                      background: 'rgba(79,70,229,0.2)',
                      color: '#818CF8',
                    }}
                  >
                    {aiLoading ? 'Generating...' : 'Generate'}
                  </button>
                </div>
                {handler && (
                  <pre
                    className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-56 leading-relaxed"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    {handler}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div>
      <div className="mb-3">
        <Link
          href="/dashboard"
          className="text-zinc-500 hover:text-white text-sm transition-colors"
        >
          ← Endpoints
        </Link>
      </div>

      <div className="flex items-start justify-between mb-4 md:mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="text-lg md:text-2xl font-semibold truncate">
            {endpoint?.name || 'Loading...'}
          </h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <code className="text-xs text-zinc-500 truncate max-w-xs md:max-w-none">
              {process.env.NEXT_PUBLIC_INGESTION_URL}/in/
              {endpoint?.public_token}
            </code>
            <span
              className="text-xs px-2 py-0.5 rounded-full border shrink-0"
              style={{
                background: live
                  ? 'rgba(34,197,94,0.1)'
                  : 'rgba(255,255,255,0.05)',
                color: live ? '#4ade80' : '#71717a',
                borderColor: live
                  ? 'rgba(34,197,94,0.2)'
                  : 'rgba(255,255,255,0.08)',
              }}
            >
              {live ? '● live' : '○ connecting'}
            </span>
          </div>
        </div>
        <button
          onClick={fetchEvents}
          className="text-xs text-zinc-400 hover:text-white border border-white/8 px-3 py-2 rounded-xl shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          Refresh
        </button>
      </div>

      {/* Mobile: show detail panel on top when event selected */}
      {showDetail && selected && (
        <div className="md:hidden mb-4">
          <DetailPanel />
        </div>
      )}

      <div className="md:grid md:grid-cols-2 md:gap-4">
        {/* Events list */}
        <div className="space-y-2">
          {loading ? (
            <p className="text-zinc-500 text-sm">Loading events...</p>
          ) : events.length === 0 ? (
            <div
              className="text-center py-12 rounded-2xl border border-dashed"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <p className="text-zinc-500 text-sm mb-1">No events yet</p>
              <p className="text-zinc-600 text-xs">
                Send a webhook to your capture URL
              </p>
            </div>
          ) : (
            events.map((event) => (
              <div
                key={event.id}
                onClick={() => selectEvent(event)}
                className="rounded-xl p-3 md:p-4 cursor-pointer transition-all border"
                style={{
                  background:
                    selected?.id === event.id
                      ? 'rgba(79,70,229,0.08)'
                      : 'rgba(255,255,255,0.02)',
                  borderColor:
                    selected?.id === event.id
                      ? 'rgba(79,70,229,0.3)'
                      : 'rgba(255,255,255,0.06)',
                }}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-medium text-zinc-300">
                      {event.method}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${statusColor[event.status] || 'text-zinc-400'}`}
                      style={{
                        background:
                          statusBg[event.status] || 'rgba(255,255,255,0.05)',
                      }}
                    >
                      {event.status}
                    </span>
                  </div>
                  <span className="text-xs text-zinc-600">
                    {new Date(event.received_at).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 truncate">
                  {event.body?.substring(0, 60)}
                </p>
              </div>
            ))
          )}
        </div>

        {/* Desktop: detail panel on right */}
        <div className="hidden md:block">
          {selected ? (
            <div className="sticky top-4">
              <DetailPanel />
            </div>
          ) : (
            <div
              className="border border-dashed rounded-2xl p-8 text-center"
              style={{ borderColor: 'rgba(255,255,255,0.06)' }}
            >
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
