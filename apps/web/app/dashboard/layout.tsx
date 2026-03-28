'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuthStore, rehydrateAuth } from '@/lib/auth'

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const { user, logout, token } = useAuthStore()

  useEffect(() => {
    rehydrateAuth()
  }, [])

  useEffect(() => {
    if (!token && typeof window !== 'undefined') {
      const stored = localStorage.getItem('hookdrop_token')
      if (!stored) {
        router.push('/auth/login')
      }
    }
  }, [token, router])

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col">
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/dashboard" className="text-lg font-semibold tracking-tight">
            Hookdrop
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-white transition-colors">
              Endpoints
            </Link>
            <Link href="/dashboard/settings" className="hover:text-white transition-colors">
              Settings
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-500">{user?.email}</span>
          <span className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-400 px-2 py-1 rounded-full">
            {user?.plan}
          </span>
          <button
            onClick={logout}
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>
      <div className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {children}
      </div>
      <footer className="border-t border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto text-xs text-zinc-600 flex justify-between">
          <span>Hookdrop — Webhook Relay & Inspector</span>
          <span>© {new Date().getFullYear()} Hookdrop</span>
        </div>
      </footer>
    </div>
  )
}
