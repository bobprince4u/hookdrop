import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col">
      <nav className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <span className="text-xl font-semibold tracking-tight">Hookdrop</span>
        <div className="flex gap-4">
          <Link href="/auth/login" className="text-sm text-zinc-400 hover:text-white transition-colors">
            Log in
          </Link>
          <Link href="/auth/register" className="text-sm bg-white text-black px-4 py-1.5 rounded-md hover:bg-zinc-200 transition-colors">
            Get started
          </Link>
        </div>
      </nav>

      <div className="flex-1 max-w-4xl mx-auto px-6 py-32 text-center">
        <div className="inline-block text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 px-3 py-1 rounded-full mb-8">
          Built for developers
        </div>
        <h1 className="text-6xl font-bold tracking-tight mb-6 leading-tight">
          Never lose a webhook again
        </h1>
        <p className="text-xl text-zinc-400 mb-12 max-w-2xl mx-auto leading-relaxed">
          Hookdrop captures every webhook, inspects the payload, forwards to any
          environment, and replays on demand. With AI that explains exactly what
          arrived and why it failed.
        </p>
        <div className="flex gap-4 justify-center">
          <Link href="/auth/register" className="bg-white text-black px-8 py-3 rounded-md font-medium hover:bg-zinc-200 transition-colors">
            Start for free
          </Link>
          <Link href="/auth/login" className="border border-zinc-700 text-zinc-300 px-8 py-3 rounded-md font-medium hover:border-zinc-500 transition-colors">
            Sign in
          </Link>
        </div>

        <div className="mt-24 grid grid-cols-3 gap-8 text-left">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">⚡</div>
            <h3 className="font-semibold mb-2">Permanent capture URL</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              One URL that never changes. Every webhook is logged in full —
              headers, body, timestamp, source IP.
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">🔄</div>
            <h3 className="font-semibold mb-2">Auto-retry forwarding</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Forward to localhost, staging, or prod. Automatic retries with
              exponential backoff when destinations fail.
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">🤖</div>
            <h3 className="font-semibold mb-2">AI-powered inspection</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              AI explains every payload in plain English, generates handler
              code, and diagnoses delivery failures.
            </p>
          </div>
        </div>

        <div className="mt-16 grid grid-cols-3 gap-8 text-left">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">🔁</div>
            <h3 className="font-semibold mb-2">One-click replay</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Replay any past event against any environment instantly.
              No more asking Stripe to resend.
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">📡</div>
            <h3 className="font-semibold mb-2">Live event stream</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Watch webhooks arrive in real time on your dashboard.
              No refreshing needed.
            </p>
          </div>
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">🛡️</div>
            <h3 className="font-semibold mb-2">Secure by default</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              HMAC signature verification, JWT auth, and tenant-isolated
              event storage built in from day one.
            </p>
          </div>
        </div>
      </div>

      <footer className="border-t border-zinc-800 px-6 py-10">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div>
            <span className="text-lg font-semibold tracking-tight">Hookdrop</span>
            <p className="text-sm text-zinc-500 mt-1">
              Webhook relay and inspector for developers.
            </p>
          </div>
          <div className="flex gap-8 text-sm text-zinc-500">
            <Link href="/auth/register" className="hover:text-white transition-colors">
              Get started
            </Link>
            <Link href="/auth/login" className="hover:text-white transition-colors">
              Sign in
            </Link>
            <a href="https://github.com/bobprince4u/hookdrop" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
              GitHub
            </a>
          </div>
          <p className="text-xs text-zinc-600">
            © {new Date().getFullYear()} Hookdrop. All rights reserved.
          </p>
        </div>
      </footer>
    </main>
  )
}
