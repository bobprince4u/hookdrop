'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/auth'

export default function RegisterPage() {
  const router = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await api.post('/api/auth/register', { name, email, password })
      setAuth(res.data.user, res.data.accessToken)
      router.push('/dashboard')
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } }
      setError(error.response?.data?.error || 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#030712' }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Link href="/" className="inline-flex flex-col items-center gap-3">
            <Image src="/hookdroplogo.png" alt="Hookdrop" width={52} height={52} className="rounded-2xl" />
            <span className="text-xl font-semibold tracking-tight">Hookdrop</span>
          </Link>
          <p className="text-zinc-500 text-sm mt-2">Create your free account</p>
        </div>

        <div className="rounded-2xl border border-white/5 p-8" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <form onSubmit={handleRegister} className="space-y-4">
            {error && (
              <div className="text-sm px-4 py-3 rounded-xl border" style={{ background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.2)', color: '#f87171' }}>
                {error}
              </div>
            )}
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5 font-medium">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl px-4 py-2.5 text-sm focus:outline-none transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#f9fafb' }}
                placeholder="Princewill"
                required
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5 font-medium">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl px-4 py-2.5 text-sm focus:outline-none transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#f9fafb' }}
                placeholder="you@example.com"
                required
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5 font-medium">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl px-4 py-2.5 text-sm focus:outline-none transition-colors"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#f9fafb' }}
                placeholder="••••••••"
                required
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-white transition-all hover:opacity-90 disabled:opacity-50 mt-2"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
            >
              {loading ? 'Creating account...' : 'Create free account'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-zinc-600 mt-6">
          Already have an account?{' '}
          <Link href="/auth/login" className="text-indigo-400 hover:text-indigo-300 transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
