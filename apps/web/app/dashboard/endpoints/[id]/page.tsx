'use client'

import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, describeApiError, getAccessToken } from '@/lib/api'
import Link from 'next/link'
import { io } from 'socket.io-client'

/**
 * Endpoint event inspector (H-34, H-16, H-48).
 *
 * ## What was wrong
 *
 * `DetailPanel` — 220 lines of it — was declared *inside* this component. A function
 * declared in a render body is a new function on every render, and React compares
 * component identity to decide whether to update a subtree or replace it. So every
 * arriving webhook, every keystroke, every state change anywhere on the page unmounted the
 * entire detail panel and mounted a fresh one: scroll position gone, text selection gone,
 * and any AI output the user had just generated gone with it. On a live feed that is a
 * panel that erases itself while being read.
 *
 * It is now a module-scope `memo` component. Two consequences make the fix real rather
 * than cosmetic:
 *
 *  - it owns its own AI and replay state, so generating a schema no longer re-renders the
 *    event list, and
 *  - the parent passes `key={selected.id}`, which is React's idiom for "reset this
 *    subtree's state when the identity changes" — selecting a different event clears the
 *    previous event's AI output, which is what the old remount-everything behaviour
 *    achieved by accident.
 *
 * The socket handler had no deduplication (`setEvents(prev => [event, ...prev])`
 * unconditionally) and no cap, so a reconnect that replayed events showed duplicates and a
 * long-lived tab grew without bound — each entry holding a full body and header set.
 *
 * ## Socket authentication
 *
 * `io(...)` was called with no credential. The API now authenticates the handshake and
 * only lets an authenticated socket join a room it owns (H-13), so this page would connect
 * successfully, have its `join` refused, and sit there showing "live" while receiving
 * nothing. The token is supplied through the function form of `auth` so that a reconnect
 * reads the *current* access token rather than the one captured when the socket was built —
 * access tokens are 15-minute now (H-16) and a reconnect can easily outlive one.
 */

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

/**
 * A live tab used to accumulate events forever, each one carrying a full body and header
 * set. This bounds what one open page can hold; the server is the source of truth for
 * anything older, and the Refresh button re-reads it.
 */
const MAX_EVENTS = 200

const API_URL = process.env.NEXT_PUBLIC_API_URL

/**
 * Mirrors `AI_LANGUAGES` / `AI_FRAMEWORKS` in the API's validation schemas, which are
 * closed `z.enum`s because these values reach a `varchar(50)` cache key and a model
 * prompt (H-22).
 *
 * Both lists are complete rather than a subset. They were a hand-picked four and five,
 * which meant the API accepted nine languages and thirteen frameworks that no user could
 * ask for — the generator supported Rails, Spring, Laravel and the rest, and the dropdown
 * simply did not mention them.
 *
 * **The pairing is the reason this is a map and not two flat lists.** The API validates
 * `language` and `framework` independently, so `{language: 'go', framework: 'django'}`
 * passes validation and becomes the prompt "Write a complete go webhook handler for
 * django". Nothing downstream rejects it; the model is left to reconcile a combination
 * the user never meant to express. Offering only the frameworks that belong to the
 * selected language makes that request unrepresentable from the UI.
 *
 * Until `packages/shared` exists (H-35) this cannot import the API's enums, so a value
 * added there must be added here too. Every value below must appear in the API's enum —
 * one that does not is a 400 on a control the user can reach.
 */
const AI_LANGUAGES = [
  { value: 'typescript', label: 'TypeScript' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python', label: 'Python' },
  { value: 'go', label: 'Go' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'java', label: 'Java' },
  { value: 'csharp', label: 'C#' },
  { value: 'rust', label: 'Rust' },
] as const

type AiLanguage = (typeof AI_LANGUAGES)[number]['value']

interface FrameworkOption {
  value: string
  label: string
}

/** Every framework in the API's enum, under the language it belongs to. */
const AI_FRAMEWORKS: Record<AiLanguage, readonly FrameworkOption[]> = {
  typescript: [
    { value: 'express', label: 'Express' },
    { value: 'fastify', label: 'Fastify' },
    { value: 'nextjs', label: 'Next.js' },
    { value: 'nestjs', label: 'NestJS' },
  ],
  javascript: [
    { value: 'express', label: 'Express' },
    { value: 'fastify', label: 'Fastify' },
    { value: 'nextjs', label: 'Next.js' },
  ],
  python: [
    { value: 'fastapi', label: 'FastAPI' },
    { value: 'flask', label: 'Flask' },
    { value: 'django', label: 'Django' },
  ],
  go: [{ value: 'gin', label: 'Gin' }],
  ruby: [{ value: 'rails', label: 'Rails' }],
  php: [{ value: 'laravel', label: 'Laravel' }],
  java: [{ value: 'spring', label: 'Spring' }],
  csharp: [{ value: 'aspnet', label: 'ASP.NET' }],
  rust: [{ value: 'axum', label: 'Axum' }],
}

const formatBody = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

interface PlanGate {
  blocked: boolean
  expired: boolean
}

/**
 * Reads the plan gate out of a 403.
 *
 * Two middlewares can refuse an AI request and they answer differently: `requirePlan`
 * rejects first with `code: 'plan_required'` and a `plan_expired` flag, and the controller's
 * own entitlement check answers `upgrade_required` if it is ever reached. This page only
 * looked for `upgrade_required`, which is the one that `requirePlan` never sends — so once
 * authorization was actually mounted, a free user clicking the AI tab saw nothing happen at
 * all. Both shapes count, and `plan_expired` distinguishes "never subscribed" from
 * "subscription lapsed", which is exactly why the API bothers to send it.
 */
const readPlanGate = (error: unknown): PlanGate => {
  const response = (
    error as { response?: { status?: number; data?: Record<string, unknown> } }
  )?.response

  if (response?.status !== 403) return { blocked: false, expired: false }

  const body = response.data ?? {}
  const blocked =
    body.upgrade_required === true || body.code === 'plan_required'

  return { blocked, expired: blocked && body.plan_expired === true }
}

/* -------------------------------------------------------------------------- */
/* Event list row                                                             */
/* -------------------------------------------------------------------------- */

interface EventRowProps {
  event: Event
  isSelected: boolean
  onSelect: (event: Event) => void
}

const EventRow = memo(function EventRow({
  event,
  isSelected,
  onSelect,
}: EventRowProps) {
  return (
    <div
      onClick={() => onSelect(event)}
      className="rounded-xl p-3 md:p-4 cursor-pointer transition-all border"
      style={{
        background: isSelected
          ? 'rgba(79,70,229,0.08)'
          : 'rgba(255,255,255,0.02)',
        borderColor: isSelected
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
              background: statusBg[event.status] || 'rgba(255,255,255,0.05)',
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
  )
})

/* -------------------------------------------------------------------------- */
/* Detail panel                                                               */
/* -------------------------------------------------------------------------- */

interface DetailPanelProps {
  event: Event
  endpointId: string
  onClose: () => void
  onReplayed: () => void
}

const DetailPanel = memo(function DetailPanel({
  event,
  endpointId,
  onClose,
  onReplayed,
}: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState<'payload' | 'headers' | 'ai'>(
    'payload'
  )
  const [replaying, setReplaying] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [schema, setSchema] = useState('')
  const [handler, setHandler] = useState('')
  const [language, setLanguage] = useState<AiLanguage>(AI_LANGUAGES[0].value)
  const [framework, setFramework] = useState<string>(
    AI_FRAMEWORKS[AI_LANGUAGES[0].value][0].value
  )
  const [planGate, setPlanGate] = useState<PlanGate>({
    blocked: false,
    expired: false,
  })
  const [error, setError] = useState<string | null>(null)

  const frameworks = AI_FRAMEWORKS[language]

  /**
   * Derived rather than reset from an effect. Switching from Python to Go leaves
   * `framework` holding `fastapi`, which Go does not offer; resolving that here means the
   * stale value is never the one submitted, and there is no render in which the two
   * selects disagree. Syncing it with an effect would send the mismatched pair on any
   * click that landed in the same tick as the reset.
   */
  const activeFramework = frameworks.some((f) => f.value === framework)
    ? framework
    : frameworks[0].value

  const aiBase = `/api/endpoints/${endpointId}/events/${event.id}/ai`

  /**
   * An AI failure used to be swallowed entirely unless it carried
   * `upgrade_required` — a rate limit, a Gemini outage or a missing API key all
   * presented as a button that did nothing.
   */
  const handleAiError = useCallback((err: unknown) => {
    const gate = readPlanGate(err)
    if (gate.blocked) {
      setPlanGate(gate)
      return
    }
    console.error('AI request failed:', describeApiError(err))
    setError(describeApiError(err))
  }, [])

  const loadExplanation = useCallback(async () => {
    if (explanation || aiLoading) return
    setAiLoading(true)
    setError(null)
    try {
      const res = await api.get(`${aiBase}/explain`)
      if (typeof res.data?.explanation === 'string') {
        setExplanation(res.data.explanation)
      }
    } catch (err) {
      handleAiError(err)
    } finally {
      setAiLoading(false)
    }
  }, [aiBase, explanation, aiLoading, handleAiError])

  const loadSchema = useCallback(async () => {
    if (schema || aiLoading) return
    setAiLoading(true)
    setError(null)
    try {
      const res = await api.get(`${aiBase}/schema`)
      if (typeof res.data?.schema === 'string') setSchema(res.data.schema)
    } catch (err) {
      handleAiError(err)
    } finally {
      setAiLoading(false)
    }
  }, [aiBase, schema, aiLoading, handleAiError])

  const loadHandler = useCallback(async () => {
    if (aiLoading) return
    setAiLoading(true)
    setError(null)
    try {
      const res = await api.post(`${aiBase}/handler`, {
        language,
        framework: activeFramework,
      })
      if (typeof res.data?.handler === 'string') setHandler(res.data.handler)
    } catch (err) {
      handleAiError(err)
    } finally {
      setAiLoading(false)
    }
  }, [aiBase, language, activeFramework, aiLoading, handleAiError])

  const replayEvent = useCallback(async () => {
    setReplaying(true)
    setError(null)
    try {
      await api.post(
        `/api/endpoints/${endpointId}/events/${event.id}/replay`
      )
      // The worker picks the job up asynchronously; give it a moment, then re-read.
      setTimeout(onReplayed, 2000)
    } catch (err) {
      console.error('Replay failed:', describeApiError(err))
      setError(describeApiError(err))
    } finally {
      setReplaying(false)
    }
  }, [endpointId, event.id, onReplayed])

  const prettyBody = useMemo(() => formatBody(event.body), [event.body])
  const prettyHeaders = useMemo(
    () => JSON.stringify(event.headers, null, 2),
    [event.headers]
  )

  return (
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
                if (tab === 'ai') void loadExplanation()
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
            onClick={() => void replayEvent()}
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
            onClick={onClose}
            className="md:hidden text-xs text-zinc-500 hover:text-white px-2 py-1.5"
          >
            ✕
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

      {activeTab === 'payload' && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Event ID</p>
            <code className="text-xs text-zinc-300 break-all">{event.id}</code>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Received at</p>
            <p className="text-xs text-zinc-300">
              {new Date(event.received_at).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-1">Source IP</p>
            <p className="text-xs text-zinc-300">{event.source_ip}</p>
          </div>
          <div>
            <p className="text-xs text-zinc-500 mb-2">Payload</p>
            <pre
              className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-64 leading-relaxed"
              style={{ background: 'rgba(255,255,255,0.04)' }}
            >
              {prettyBody}
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
            {prettyHeaders}
          </pre>
          {/*
            Credential-bearing headers are stripped at the ingest write path now (H-17),
            so a recently captured event shows `[redacted]` where a sender put an
            `Authorization` header. Events stored before that change still hold whatever
            was sent.
          */}
          <p className="text-xs text-zinc-600 mt-2">
            Authorization, cookie and provider signature headers are redacted before
            storage.
          </p>
        </div>
      )}

      {activeTab === 'ai' && (
        <div className="space-y-4">
          {planGate.blocked ? (
            <div
              className="text-center py-6 rounded-2xl border border-dashed"
              style={{
                borderColor: 'rgba(79,70,229,0.3)',
                background: 'rgba(79,70,229,0.05)',
              }}
            >
              <div className="text-xl mb-2">✦</div>
              <h3 className="font-medium text-sm mb-1">
                {planGate.expired
                  ? 'Your subscription has lapsed'
                  : 'AI requires a paid plan'}
              </h3>
              <p className="text-xs text-zinc-500 mb-3">
                {planGate.expired
                  ? 'Renew to restore AI features on this endpoint.'
                  : 'Upgrade to Starter or above to unlock AI features.'}
              </p>
              <Link
                href="/dashboard/billing"
                className="inline-block text-xs font-medium px-4 py-2 rounded-lg text-white"
                style={{
                  background:
                    'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
                }}
              >
                {planGate.expired ? 'Renew plan →' : 'Upgrade plan →'}
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
                      onClick={() => void loadSchema()}
                      disabled={aiLoading}
                      className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
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
                    onChange={(e) =>
                      setLanguage(e.target.value as AiLanguage)
                    }
                    aria-label="Language"
                    className="text-xs rounded-lg px-2 py-1"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#d4d4d8',
                    }}
                  >
                    {AI_LANGUAGES.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={activeFramework}
                    onChange={(e) => setFramework(e.target.value)}
                    aria-label="Framework"
                    disabled={frameworks.length === 1}
                    className="text-xs rounded-lg px-2 py-1 disabled:opacity-60"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      color: '#d4d4d8',
                    }}
                  >
                    {frameworks.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => void loadHandler()}
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
})

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function EndpointEventsPage() {
  const params = useParams()
  /** `useParams` types every value as `string | string[]`; a catch-all route would give an array. */
  const endpointId = Array.isArray(params.id) ? params.id[0] : params.id

  const [endpoint, setEndpoint] = useState<Endpoint | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [selected, setSelected] = useState<Event | null>(null)
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)

  const fetchEndpoint = useCallback(async () => {
    if (!endpointId) return
    try {
      const res = await api.get(`/api/endpoints/${endpointId}`)
      setEndpoint(res.data?.endpoint ?? null)
    } catch (err) {
      console.error('Endpoint load failed:', describeApiError(err))
      setError(describeApiError(err))
    }
  }, [endpointId])

  const fetchEvents = useCallback(async () => {
    if (!endpointId) return
    try {
      const res = await api.get(`/api/endpoints/${endpointId}/events`)
      setEvents(
        Array.isArray(res.data?.events)
          ? res.data.events.slice(0, MAX_EVENTS)
          : []
      )
      setTotal(
        typeof res.data?.pagination?.total === 'number'
          ? res.data.pagination.total
          : null
      )
      setError(null)
    } catch (err) {
      console.error('Event load failed:', describeApiError(err))
      setError(describeApiError(err))
    } finally {
      setLoading(false)
    }
  }, [endpointId])

  useEffect(() => {
    void fetchEndpoint()
    void fetchEvents()
  }, [fetchEndpoint, fetchEvents])

  useEffect(() => {
    if (!endpoint || !API_URL) return

    const socket = io(API_URL, {
      // Function form, evaluated per connection attempt: a reconnect after the 15-minute
      // access token has rotated must present the new one, not the one captured here.
      auth: (cb) => cb({ token: getAccessToken() }),
    })

    socket.on('connect', () => {
      socket.emit('join', endpoint.public_token)
    })

    // `joined`/`join_error` are the API's reply to `join` (H-13). Reporting "live" on
    // `connect` alone showed a green dot for a socket whose join had been refused.
    socket.on('joined', () => setLive(true))
    socket.on('join_error', () => {
      console.error('Live feed unavailable: join refused')
      setLive(false)
    })

    socket.on('new_event', (event: Event) => {
      if (!event?.id) return
      setEvents((prev) =>
        prev.some((existing) => existing.id === event.id)
          ? prev
          : [event, ...prev].slice(0, MAX_EVENTS)
      )
      setTotal((prev) => (prev === null ? prev : prev + 1))
    })

    socket.on('connect_error', () => setLive(false))
    socket.on('disconnect', () => setLive(false))

    return () => {
      socket.disconnect()
    }
  }, [endpoint])

  const selectEvent = useCallback((event: Event) => {
    setSelected(event)
    setShowDetail(true)
  }, [])

  const closeDetail = useCallback(() => setShowDetail(false), [])

  const truncated = total !== null && total > events.length

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
          onClick={() => void fetchEvents()}
          className="text-xs text-zinc-400 hover:text-white border px-3 py-2 rounded-xl shrink-0"
          style={{ borderColor: 'rgba(255,255,255,0.08)' }}
        >
          Refresh
        </button>
      </div>

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

      {/* Mobile: show detail panel on top when event selected */}
      {showDetail && selected && endpointId && (
        <div className="md:hidden mb-4">
          <DetailPanel
            key={selected.id}
            event={selected}
            endpointId={endpointId}
            onClose={closeDetail}
            onReplayed={fetchEvents}
          />
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
            <>
              {events.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  isSelected={selected?.id === event.id}
                  onSelect={selectEvent}
                />
              ))}
              {/*
                The events endpoint is paginated now (H-20), so this list is the most
                recent page rather than everything. Saying so beats letting it look like
                older events were lost.
              */}
              {truncated && (
                <p className="text-xs text-zinc-600 text-center pt-2">
                  Showing the {events.length} most recent of{' '}
                  {total?.toLocaleString()} events.
                </p>
              )}
            </>
          )}
        </div>

        {/* Desktop: detail panel on right */}
        <div className="hidden md:block">
          {selected && endpointId ? (
            <div className="sticky top-4">
              <DetailPanel
                key={selected.id}
                event={selected}
                endpointId={endpointId}
                onClose={closeDetail}
                onReplayed={fetchEvents}
              />
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
