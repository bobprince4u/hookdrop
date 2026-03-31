'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
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
      if (!stored) router.push('/auth/login')
    }
  }, [token, router])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#030712' }}>
      <nav className="border-b border-white/5 px-6 py-3.5 flex items-center justify-between sticky top-0 z-50 backdrop-blur-sm" style={{ background: 'rgba(3,7,18,0.9)' }}>
        <div className="flex items-center gap-8">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <Image src="/hookdroplogo.png" alt="Hookdrop" width={28} height={28} className="rounded-lg" />
            <span className="font-semibold tracking-tight">Hookdrop</span>
          </Link>
          <div className="flex gap-6 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-white transition-colors">Endpoints</Link>
            <Link href="/dashboard/billing" className="hover:text-white transition-colors">Billing</Link>
            <Link href="/dashboard/settings" className="hover:text-white transition-colors">Settings</Link>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-zinc-500">{user?.email}</span>
          <span
            className="text-xs px-2.5 py-1 rounded-full font-medium capitalize"
            style={{ background: 'rgba(79,70,229,0.15)', color: '#818CF8', border: '1px solid rgba(79,70,229,0.3)' }}
          >
            {user?.plan}
          </span>
          <button
            onClick={logout}
            className="text-sm text-zinc-500 hover:text-white transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>

      <div className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {children}
      </div>

      <footer className="border-t border-white/5 px-6 py-4">
        <div className="max-w-6xl mx-auto text-xs text-zinc-700 flex justify-between">
          <span>Hookdrop — Webhook Relay & Inspector</span>
          <span>© {new Date().getFullYear()} Hookdrop</span>
        </div>
      </footer>
    </div>
  )
}
