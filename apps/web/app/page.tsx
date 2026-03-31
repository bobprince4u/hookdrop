import Link from 'next/link'
import Image from 'next/image'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col" style={{ background: '#030712' }}>

      {/* Navbar */}
      <nav className="border-b border-white/5 px-6 py-4 flex items-center justify-between backdrop-blur-sm sticky top-0 z-50" style={{ background: 'rgba(3,7,18,0.8)' }}>
        <div className="flex items-center gap-2.5">
          <Image src="/hookdroplogo.png" alt="Hookdrop" width={32} height={32} className="rounded-lg" />
          <span className="text-lg font-semibold tracking-tight">Hookdrop</span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
          <Link href="/auth/login" className="hover:text-white transition-colors">Log in</Link>
        </div>
        <Link
          href="/auth/register"
          className="text-sm font-medium px-4 py-2 rounded-lg text-white transition-all hover:opacity-90"
          style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
        >
          Get started free
        </Link>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-32 relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-10 blur-3xl" style={{ background: 'radial-gradient(circle, #4F46E5, transparent)' }} />
        </div>

        <div className="relative z-10 max-w-4xl mx-auto">
          <Image
            src="/hookdroplogo.png"
            alt="Hookdrop"
            width={80}
            height={80}
            className="mx-auto mb-8 rounded-2xl"
          />

          <div className="inline-flex items-center gap-2 text-xs font-medium border border-indigo-500/30 text-indigo-400 px-4 py-1.5 rounded-full mb-8" style={{ background: 'rgba(79,70,229,0.1)' }}>
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span>
            Now in early access — join the waitlist
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-tight">
            Never lose a{' '}
            <span className="brand-text">webhook</span>{' '}
            again
          </h1>

          <p className="text-xl text-zinc-400 mb-10 max-w-2xl mx-auto leading-relaxed">
            Hookdrop captures every webhook, inspects the payload, forwards to any
            environment, and replays on demand — with AI that explains exactly what
            arrived and why it failed.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/auth/register"
              className="text-sm font-medium px-8 py-3.5 rounded-xl text-white transition-all hover:opacity-90 hover:scale-105"
              style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
            >
              Start for free — no credit card
            </Link>
            <Link
              href="/auth/login"
              className="text-sm font-medium px-8 py-3.5 rounded-xl border border-white/10 text-zinc-300 hover:border-white/20 hover:text-white transition-all"
            >
              Sign in →
            </Link>
          </div>

          <p className="text-xs text-zinc-600 mt-4">Free plan includes 500 events/month</p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-6 py-24 max-w-6xl mx-auto w-full">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">Everything you need to debug webhooks</h2>
          <p className="text-zinc-400 max-w-xl mx-auto">Stop losing events. Start shipping faster.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {[
            {
              icon: '⚡',
              title: 'Permanent capture URL',
              desc: 'One URL that never changes or goes down. Every webhook logged in full — headers, body, timestamp, source IP.',
              color: '#3B82F6',
            },
            {
              icon: '🔄',
              title: 'Auto-retry forwarding',
              desc: 'Forward to localhost, staging, or prod simultaneously. Automatic retries with exponential backoff.',
              color: '#4F46E5',
            },
            {
              icon: '✦',
              title: 'AI-powered inspection',
              desc: 'AI explains every payload in plain English, generates TypeScript types, writes handler code for you.',
              color: '#818CF8',
            },
            {
              icon: '↺',
              title: 'One-click replay',
              desc: 'Replay any past event against any environment instantly. No more asking Stripe to resend.',
              color: '#3B82F6',
            },
            {
              icon: '📡',
              title: 'Live event stream',
              desc: 'Watch webhooks arrive in real time on your dashboard via WebSocket. No refreshing needed.',
              color: '#4F46E5',
            },
            {
              icon: '🛡️',
              title: 'Secure by default',
              desc: 'HMAC signature verification, JWT auth, and tenant-isolated event storage built in from day one.',
              color: '#818CF8',
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl p-6 border border-white/5 hover:border-white/10 transition-all group"
              style={{ background: 'rgba(255,255,255,0.02)' }}
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center text-lg mb-4"
                style={{ background: `${feature.color}20`, border: `1px solid ${feature.color}30` }}
              >
                {feature.icon}
              </div>
              <h3 className="font-semibold mb-2 group-hover:text-white transition-colors">{feature.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-24 max-w-6xl mx-auto w-full">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4">Simple, usage-based pricing</h2>
          <p className="text-zinc-400">Start free. Upgrade when you need more.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {[
            {
              name: 'Free',
              price: '₦0',
              period: '/mo',
              events: '500 events',
              retention: '24hr retention',
              endpoints: '2 endpoints',
              highlight: false,
            },
            {
              name: 'Starter',
              price: '₦7,500',
              period: '/mo',
              events: '10,000 events',
              retention: '7 day retention',
              endpoints: '5 endpoints',
              highlight: false,
            },
            {
              name: 'Pro',
              price: '₦19,000',
              period: '/mo',
              events: '100,000 events',
              retention: '30 day retention',
              endpoints: 'Unlimited',
              highlight: true,
            },
            {
              name: 'Team',
              price: '₦49,000',
              period: '/mo',
              events: '500,000 events',
              retention: '90 day retention',
              endpoints: 'Unlimited',
              highlight: false,
            },
          ].map((plan) => (
            <div
              key={plan.name}
              className={`rounded-2xl p-6 border transition-all relative ${
                plan.highlight
                  ? 'border-indigo-500/50'
                  : 'border-white/5 hover:border-white/10'
              }`}
              style={{
                background: plan.highlight
                  ? 'rgba(79,70,229,0.1)'
                  : 'rgba(255,255,255,0.02)',
              }}
            >
              {plan.highlight && (
                <div
                  className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-medium px-3 py-1 rounded-full text-white"
                  style={{ background: 'linear-gradient(135deg, #3B82F6, #4F46E5)' }}
                >
                  Most popular
                </div>
              )}
              <h3 className="font-semibold mb-1">{plan.name}</h3>
              <div className="flex items-baseline gap-0.5 mb-6">
                <span className="text-3xl font-bold">{plan.price}</span>
                <span className="text-zinc-500 text-sm">{plan.period}</span>
              </div>
              <div className="space-y-2.5 mb-6 text-sm text-zinc-400">
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">✓</span> {plan.events}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">✓</span> {plan.retention}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">✓</span> {plan.endpoints}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">✓</span> AI features
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400">✓</span> Live event stream
                </div>
              </div>
              <Link
                href="/auth/register"
                className={`block text-center text-sm font-medium py-2.5 rounded-xl transition-all ${
                  plan.highlight
                    ? 'text-white hover:opacity-90'
                    : 'border border-white/10 text-zinc-300 hover:border-white/20 hover:text-white'
                }`}
                style={plan.highlight ? { background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' } : {}}
              >
                {plan.name === 'Free' ? 'Get started free' : `Get ${plan.name}`}
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-24 text-center">
        <div
          className="max-w-2xl mx-auto rounded-3xl p-12 border border-indigo-500/20"
          style={{ background: 'rgba(79,70,229,0.08)' }}
        >
          <h2 className="text-3xl font-bold mb-4">Ready to stop losing webhooks?</h2>
          <p className="text-zinc-400 mb-8">Join developers who use Hookdrop to debug faster and ship with confidence.</p>
          <Link
            href="/auth/register"
            className="inline-block text-sm font-medium px-8 py-3.5 rounded-xl text-white transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)' }}
          >
            Start for free — no credit card required
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 px-6 py-10">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <Image src="/hookdroplogo.png" alt="Hookdrop" width={28} height={28} className="rounded-lg" />
            <div>
              <span className="font-semibold">Hookdrop</span>
              <p className="text-xs text-zinc-600 mt-0.5">Webhook relay and inspector for developers.</p>
            </div>
          </div>
          <div className="flex gap-8 text-sm text-zinc-500">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
            <Link href="/auth/register" className="hover:text-white transition-colors">Get started</Link>
            <a href="https://github.com/bobprince4u/hookdrop" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
          </div>
          <p className="text-xs text-zinc-700">© {new Date().getFullYear()} Hookdrop. All rights reserved.</p>
        </div>
      </footer>
    </main>
  )
}
