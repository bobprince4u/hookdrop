'use client'

import { useEffect, useState, useRef } from 'react'
import { io, Socket } from 'socket.io-client'
import Link from 'next/link'
import Image from 'next/image'

interface DemoEvent {
  id: string
  method: string
  body: string
  headers: Record<string, string>
  source_ip: string
  status: string
  received_at: string
}

const DEMO_TOKEN = 'demo-hookdrop-live-2024'
const INGESTION_URL = process.env.NEXT_PUBLIC_INGESTION_URL || 'https://hookdropingestion-production.up.railway.app'
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://hookdropapi-production.up.railway.app'
const CAPTURE_URL = `${INGESTION_URL}/in/${DEMO_TOKEN}`

const EXAMPLE_PAYLOADS = [
  {
    label: 'Paystack payment',
    icon: '💳',
    body: { event: 'charge.success', data: { amount: 15000, currency: 'NGN', customer: { email: 'user@example.com' }, reference: 'ref_' + Math.random().toString(36).substr(2,8) } }
  },
  {
    label: 'GitHub push',
    icon: '🐙',
    body: { event: 'push', ref: 'refs/heads/main', repository: { name: 'my-app' }, commits: [{ message: 'feat: add new feature', author: { name: 'Developer' } }] }
  },
  {
    label: 'Stripe webhook',
    icon: '⚡',
    body: { type: 'payment_intent.succeeded', data: { object: { amount: 2000, currency: 'usd', customer: 'cus_example' } } }
  },
  {
    label: 'Shopify order',
    icon: '🛍️',
    body: { topic: 'orders/create', order: { id: 12345, total_price: '99.00', currency: 'USD', customer: { email: 'buyer@example.com' } } }
  },
]

export default function DemoPage() {
  const [events, setEvents] = useState<DemoEvent[]>([])
  const [selected, setSelected] = useState<DemoEvent | null>(null)
  const [live, setLive] = useState(false)
  const [firing, setFiring] = useState(false)
  const [firedCount, setFiredCount] = useState(0)
  const [showCTA, setShowCTA] = useState(false)
  const [copied, setCopied] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const ctaTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Fetch existing demo events
  useEffect(() => {
    fetch(`${API_URL}/api/demo/events`)
      .then(r => r.json())
      .then(data => setEvents(data.events || []))
      .catch(console.error)
  }, [])

  // Connect to live WebSocket
  useEffect(() => {
    const socket = io(API_URL)
    socketRef.current = socket

    socket.on('connect', () => {
      socket.emit('join', DEMO_TOKEN)
      setLive(true)
    })

    socket.on('new_event', (event: DemoEvent) => {
      setEvents(prev => [event, ...prev.slice(0, 19)])
      setSelected(event)
    })

    socket.on('disconnect', () => setLive(false))

    return () => { socket.disconnect() }
  }, [])

  // Show CTA after 30 seconds
  useEffect(() => {
    ctaTimerRef.current = setTimeout(() => setShowCTA(true), 30000)
    return () => { if (ctaTimerRef.current) clearTimeout(ctaTimerRef.current) }
  }, [])

  const fireWebhook = async (payload: Record<string, unknown>) => {
    setFiring(true)
    try {
      // Route through Next.js API to avoid CORS issues
      await fetch('/api/demo/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      setFiredCount(c => c + 1)
      if (firedCount >= 1) setShowCTA(true)
    } catch (err) {
      console.error(err)
    } finally {
      setFiring(false)
    }
  }

  const copyUrl = () => {
    navigator.clipboard.writeText(CAPTURE_URL)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const formatBody = (body: string) => {
    try { return JSON.stringify(JSON.parse(body), null, 2) }
    catch { return body }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#030712' }}>

      {/* Navbar */}
      <nav className="border-b border-white/5 px-4 md:px-6 py-4 flex items-center justify-between sticky top-0 z-50 backdrop-blur-sm" style={{ background: 'rgba(3,7,18,0.9)' }}>
        <Link href="/" className="flex items-center gap-2">
          <Image src="/hookdroplogo.png" alt="Hookdrop" width={26} height={26} className="rounded-lg" style={{ width: 26, height: 26 }} />
          <span className="font-semibold text-sm">Hookdrop</span>
        </Link>
        <div className="flex items-center gap-3">
          <span
            className="text-xs px-2.5 py-1 rounded-full border"
            style={{
              background: live ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.05)',
              color: live ? '#4ade80' : '#71717a',
              borderColor: live ? 'rgba(34,197,94,0.2)' : 'rgba(255,255,255,0.08)',
            }}
          >
            {live ? '● Live demo' : '○ Connecting...'}
          </span>
          <Link
            href="/auth/register"
            className="text-xs font-medium px-4 py-2 rounded-lg text-white"
            style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
          >
            Create free account
          </Link>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto w-full px-4 md:px-6 py-8 flex-1">

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl md:text-4xl font-bold mb-3">
            See Hookdrop in action
          </h1>
          <p className="text-zinc-400 text-sm md:text-base max-w-xl mx-auto">
            This is a live demo. Send a webhook below and watch it appear on the dashboard in real time. No signup needed.
          </p>
        </div>

        {/* Capture URL */}
        <div className="rounded-2xl border border-white/5 p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center gap-3" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-zinc-500 mb-1">Demo capture URL — send any webhook here</p>
            <code className="text-xs text-indigo-400 break-all">{CAPTURE_URL}</code>
          </div>
          <button
            onClick={copyUrl}
            className="text-xs px-4 py-2 rounded-lg shrink-0 transition-colors"
            style={{ background: 'rgba(79,70,229,0.15)', color: copied ? '#4ade80' : '#818CF8' }}
          >
            {copied ? 'Copied!' : 'Copy URL'}
          </button>
        </div>

        {/* One-click payload buttons */}
        <div className="mb-6">
          <p className="text-xs text-zinc-500 mb-3">Or fire a sample webhook with one click:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PAYLOADS.map((p) => (
              <button
                key={p.label}
                onClick={() => fireWebhook(p.body)}
                disabled={firing}
                className="flex items-center gap-2 text-xs px-4 py-2.5 rounded-xl border transition-all hover:border-indigo-500/40 disabled:opacity-50"
                style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.08)' }}
              >
                <span>{p.icon}</span>
                <span>{p.label}</span>
                {firing && <span className="w-3 h-3 border border-white/30 border-t-white rounded-full animate-spin" />}
              </button>
            ))}
          </div>
        </div>

        {/* Main demo area */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Events list */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium">Events</p>
              <span className="text-xs text-zinc-500">{events.length} captured (last 1 hour)</span>
            </div>
            {events.length === 0 ? (
              <div
                className="rounded-2xl border border-dashed p-12 text-center"
                style={{ borderColor: 'rgba(255,255,255,0.06)' }}
              >
                <p className="text-zinc-500 text-sm mb-2">No events yet</p>
                <p className="text-zinc-600 text-xs">Fire a sample webhook above or send one to the capture URL</p>
              </div>
            ) : (
              <div className="space-y-2">
                {events.map((event) => (
                  <div
                    key={event.id}
                    onClick={() => setSelected(event)}
                    className="rounded-xl p-3 cursor-pointer transition-all border"
                    style={{
                      background: selected?.id === event.id ? 'rgba(79,70,229,0.08)' : 'rgba(255,255,255,0.02)',
                      borderColor: selected?.id === event.id ? 'rgba(79,70,229,0.3)' : 'rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-medium text-zinc-300">{event.method}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(34,197,94,0.1)', color: '#4ade80' }}>
                          {event.status}
                        </span>
                      </div>
                      <span className="text-xs text-zinc-600">{new Date(event.received_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-xs text-zinc-500 truncate">{event.body?.substring(0, 60)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Event detail */}
          <div>
            {selected ? (
              <div className="rounded-2xl border p-4 sticky top-20" style={{ background: 'rgba(255,255,255,0.02)', borderColor: 'rgba(255,255,255,0.06)' }}>
                <p className="text-sm font-medium mb-4">Event detail</p>
                <div className="space-y-3">
                  <div>
                    <p className="text-xs text-zinc-500 mb-1">Received at</p>
                    <p className="text-xs text-zinc-300">{new Date(selected.received_at).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">Payload</p>
                    <pre className="text-xs text-zinc-300 rounded-xl p-3 overflow-auto max-h-64 leading-relaxed" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      {formatBody(selected.body)}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs text-zinc-500 mb-2">Headers</p>
                    <pre className="text-xs text-zinc-400 rounded-xl p-3 overflow-auto max-h-32 leading-relaxed" style={{ background: 'rgba(255,255,255,0.04)' }}>
                      {JSON.stringify(selected.headers, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed p-8 text-center sticky top-20" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                <p className="text-zinc-600 text-sm">Click an event to inspect it</p>
              </div>
            )}
          </div>
        </div>

        {/* CTA Banner */}
        {showCTA && (
          <div
            className="mt-8 rounded-2xl p-6 md:p-8 text-center border"
            style={{ background: 'rgba(79,70,229,0.08)', borderColor: 'rgba(79,70,229,0.25)' }}
          >
            <h2 className="text-xl md:text-2xl font-bold mb-2">Ready for your own private endpoint?</h2>
            <p className="text-zinc-400 text-sm mb-6 max-w-lg mx-auto">
              This demo is shared with everyone. Create a free account and get your own permanent capture URL — private, permanent, and never shared.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/auth/register"
                className="text-sm font-medium px-8 py-3 rounded-xl text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
              >
                Create free account — no credit card
              </Link>
              <Link
                href="/"
                className="text-sm font-medium px-8 py-3 rounded-xl border border-white/10 text-zinc-300 hover:text-white transition-colors"
              >
                Learn more →
              </Link>
            </div>
            <p className="text-xs text-zinc-600 mt-3">Free plan includes 500 events/month</p>
          </div>
        )}

      </div>

      {/* Persistent bottom CTA for mobile */}
      {!showCTA && events.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-4 md:hidden" style={{ background: 'rgba(3,7,18,0.95)', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <Link
            href="/auth/register"
            className="block text-center text-sm font-medium py-3 rounded-xl text-white"
            style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
          >
            Create your own endpoint — free
          </Link>
        </div>
      )}
    </div>
  )
}
