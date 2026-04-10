'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useAuthStore, rehydrateAuth } from '@/lib/auth'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { user, logout, token, refreshPlan } = useAuthStore()
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => { rehydrateAuth() }, [])

  useEffect(() => {
    if (!token && typeof window !== 'undefined') {
      const stored = localStorage.getItem('hookdrop_token')
      if (!stored) router.push('/auth/login')
    }
  }, [token, router])

  useEffect(() => {
    if (!token) return
    refreshPlan()
    const interval = setInterval(refreshPlan, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [token, refreshPlan])

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#030712' }}>
      <nav className="border-b border-white/5 px-4 md:px-6 py-3.5 flex items-center justify-between sticky top-0 z-50 backdrop-blur-sm" style={{ background: 'rgba(3,7,18,0.9)' }}>
        <div className="flex items-center gap-4 md:gap-8">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Image src="/hookdroplogo.png" alt="Hookdrop" width={26} height={26} className="rounded-lg" />
            <span className="font-semibold text-sm tracking-tight">Hookdrop</span>
          </Link>
          <div className="hidden md:flex gap-5 text-sm text-zinc-400">
            <Link href="/dashboard" className="hover:text-white transition-colors">Endpoints</Link>
            <Link href="/dashboard/billing" className="hover:text-white transition-colors">Billing</Link>
            <Link href="/dashboard/settings" className="hover:text-white transition-colors">Settings</Link>
            <a href="https://bobprince.mintlify.app" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center gap-1">
              Docs <span className="text-xs text-zinc-600">↗</span>
            </a>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden md:block text-sm text-zinc-500">{user?.email}</span>
          <span className="text-xs px-2 py-1 rounded-full font-medium capitalize hidden md:block" style={{ background: 'rgba(79,70,229,0.15)', color: '#818CF8', border: '1px solid rgba(79,70,229,0.3)' }}>
            {user?.plan}
          </span>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="md:hidden text-zinc-400 hover:text-white p-1"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {menuOpen
                ? <path d="M18 6L6 18M6 6l12 12"/>
                : <path d="M3 12h18M3 6h18M3 18h18"/>
              }
            </svg>
          </button>
          <button onClick={logout} className="hidden md:block text-sm text-zinc-500 hover:text-white transition-colors">
            Sign out
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-b border-white/5 px-4 py-3 space-y-3" style={{ background: 'rgba(3,7,18,0.95)' }}>
          <div className="text-xs text-zinc-500 pb-2 border-b border-white/5">
            {user?.email} · <span className="capitalize text-indigo-400">{user?.plan}</span>
          </div>
          <Link href="/dashboard" onClick={() => setMenuOpen(false)} className="block text-sm text-zinc-300 hover:text-white py-1">Endpoints</Link>
          <Link href="/dashboard/billing" onClick={() => setMenuOpen(false)} className="block text-sm text-zinc-300 hover:text-white py-1">Billing</Link>
          <Link href="/dashboard/settings" onClick={() => setMenuOpen(false)} className="block text-sm text-zinc-300 hover:text-white py-1">Settings</Link>
          <a href="https://bobprince.mintlify.app" target="_blank" rel="noopener noreferrer" className="block text-sm text-zinc-300 hover:text-white py-1">Docs ↗</a>
          <button onClick={() => { logout(); setMenuOpen(false) }} className="block text-sm text-zinc-500 hover:text-red-400 py-1 transition-colors">
            Sign out
          </button>
        </div>
      )}

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 md:px-6 py-6 md:py-8">
        {children}
      </div>

      <footer className="border-t border-white/5 px-4 md:px-6 py-4">
        <div className="max-w-6xl mx-auto text-xs text-zinc-700 flex flex-col md:flex-row justify-between gap-1 text-center md:text-left">
          <span>Hookdrop — Webhook Relay & Inspector</span>
          <span>© {new Date().getFullYear()} Hookdrop</span>
        </div>
      </footer>
    </div>
  )
}
