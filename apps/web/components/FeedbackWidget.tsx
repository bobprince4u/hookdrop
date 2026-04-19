'use client'

import { useState } from 'react'
import { api } from '@/lib/api'

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<'bug' | 'feature' | 'general'>('general')
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (!message.trim()) return
    setLoading(true)
    try {
      await api.post('/api/feedback', { type, message })
      setSent(true)
      setTimeout(() => { setOpen(false); setSent(false); setMessage('') }, 2000)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-6 right-6 z-50 text-xs font-medium px-4 py-2.5 rounded-full text-white shadow-lg transition-all hover:opacity-90"
        style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
      >
        Feedback
      </button>

      {/* Feedback panel */}
      {open && (
        <div
          className="fixed bottom-16 right-6 z-50 w-80 rounded-2xl border p-5 shadow-xl"
          style={{ background: '#0f0f13', borderColor: 'rgba(255,255,255,0.1)' }}
        >
          {sent ? (
            <div className="text-center py-4">
              <p className="text-green-400 font-medium text-sm">Thanks for the feedback!</p>
              <p className="text-zinc-500 text-xs mt-1">We read every message.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium">Send feedback</h3>
                <button onClick={() => setOpen(false)} className="text-zinc-500 hover:text-white text-xs">✕</button>
              </div>

              <div className="flex gap-2 mb-3">
                {(['bug', 'feature', 'general'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className="text-xs px-3 py-1 rounded-lg capitalize transition-colors"
                    style={{
                      background: type === t ? 'rgba(79,70,229,0.2)' : 'rgba(255,255,255,0.05)',
                      color: type === t ? '#818CF8' : '#71717a',
                      border: `1px solid ${type === t ? 'rgba(79,70,229,0.3)' : 'rgba(255,255,255,0.08)'}`,
                    }}
                  >
                    {t === 'bug' ? 'Bug' : t === 'feature' ? 'Feature' : 'General'}
                  </button>
                ))}
              </div>

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  type === 'bug' ? "What went wrong? What did you expect?" :
                  type === 'feature' ? "What would you like to see?" :
                  "What's on your mind?"
                }
                rows={4}
                className="w-full text-xs rounded-xl px-3 py-2.5 resize-none focus:outline-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#f9fafb' }}
              />

              <button
                onClick={submit}
                disabled={loading || !message.trim()}
                className="w-full text-xs font-medium py-2.5 rounded-xl text-white mt-3 transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
              >
                {loading ? 'Sending...' : 'Send feedback'}
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
