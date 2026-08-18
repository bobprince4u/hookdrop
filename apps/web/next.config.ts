import type { NextConfig } from 'next'

/**
 * Security headers (H-42).
 *
 * This file was the stub `create-next-app` generates — a `nextConfig` object containing only
 * a `/* config options here *\/` comment — so the app shipped with no CSP, no HSTS, no
 * framing protection and no referrer policy, and advertised its framework in
 * `X-Powered-By` on every response.
 *
 * ## Why the headers live here and not in a proxy
 *
 * `next.config.ts` headers are compiled into the build's routes manifest and applied by the
 * server without rendering anything, so every route — static pages, route handlers, `/public`
 * assets — gets them at no per-request cost. The alternative the Next.js docs describe is a
 * nonce-based CSP generated in `proxy.ts`, which is strictly stronger but, per
 * `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`, requires **every
 * page to be dynamically rendered**: static optimisation and ISR are disabled, CDN caching
 * stops working, and Partial Prerendering becomes incompatible. Half this app is a marketing
 * site that should be static, so that trade is not worth making for the one inline script the
 * layout actually needs.
 *
 * ## The honest limitation
 *
 * `script-src` therefore carries `'unsafe-inline'`, which is what the docs' own no-nonce
 * example uses, and it is there for Next.js itself: the framework emits inline
 * `<script>self.__next_f.push(...)</script>` bootstrap tags to stream RSC payloads, and
 * blocking them means the app never hydrates. A CSP with `'unsafe-inline'` in `script-src` is
 * not an XSS control — an injected `<script>` still runs. What it still buys, and the reason
 * it is worth setting:
 *
 *  - `frame-ancestors 'none'` and `X-Frame-Options` stop clickjacking outright.
 *  - `object-src 'none'` removes the plugin-based XSS vectors entirely.
 *  - `base-uri 'self'` stops an injected `<base>` from re-pointing every relative script URL.
 *  - `form-action 'self'` stops an injected form from posting credentials off-origin.
 *  - `connect-src` is an allow-list, so exfiltration via `fetch`/`XHR`/WebSocket to an
 *    attacker's host is blocked even when script execution is not.
 *  - `default-src 'self'` bounds every fetch directive not named explicitly.
 *
 * Upgrading to a nonce is a contained change if the calculus shifts: generate one in
 * `proxy.ts`, drop `'unsafe-inline'` here, and opt the marketing pages into dynamic rendering.
 *
 * ## Third-party scripts
 *
 * Only Plausible remains, and it is loaded through `next/script` rather than a raw `<script>`
 * tag. Flutterwave's `checkout.flutterwave.com/v3.js` was removed from `app/layout.tsx`: it
 * was loaded on **every** route including the marketing pages, and nothing in the codebase
 * ever called `FlutterwaveCheckout` — every provider's checkout is a full-page redirect
 * (`app/dashboard/billing/page.tsx`), so the script was a third-party dependency on every
 * page load with no feature behind it. Nothing needs to be allow-listed for a redirect, which
 * is why no payment host appears below.
 */

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Browser-reachable origins the app connects to, derived from the same variables the client
 * bundle is built with.
 *
 * These are read at **build** time — headers become part of the routes manifest, not a
 * per-request computation. That is already the constraint on `NEXT_PUBLIC_*` values, which are
 * inlined into the bundle, so a deployment that builds with the right `NEXT_PUBLIC_API_URL`
 * gets the right `connect-src` for free. A deployment that does not would have a broken API
 * base URL long before the CSP mattered.
 *
 * Socket.IO is the reason each origin is emitted twice. It opens an HTTP long-poll first and
 * upgrades to a WebSocket, and `connect-src` matches on scheme — CSP3 says `'self'` covers
 * same-origin `ws:`/`wss:`, but the API is a different origin here, so `https://api.example`
 * alone would allow the poll and block the upgrade. The failure looks like an intermittently
 * dead live feed, which is a miserable thing to debug.
 */
const connectOrigins = (): string[] => {
  const origins = new Set<string>()

  for (const raw of [process.env.NEXT_PUBLIC_API_URL]) {
    if (!raw) continue
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      // A malformed value must not take the build down over a header; the bundle's own use of
      // the same variable is what will surface it.
      continue
    }
    origins.add(parsed.origin)
    origins.add(
      parsed.origin.replace(/^http/, parsed.protocol === 'https:' ? 'wss' : 'ws')
    )
  }

  return [...origins]
}

/**
 * `NEXT_PUBLIC_INGESTION_URL` is deliberately absent. It is rendered as text so a user can
 * copy their webhook URL, and the demo's own request is proxied through
 * `app/api/demo/fire/route.ts` server-side — the browser never connects to the ingestion
 * service directly. Adding it would widen the allow-list for a request that is never made.
 */
const contentSecurityPolicy = (): string => {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    // See the header comment: 'unsafe-inline' is for Next.js's own streaming bootstrap, and
    // 'unsafe-eval' only in development, where React uses eval to rebuild server stacks in the
    // browser and Turbopack's HMR client needs it.
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      'https://plausible.io',
      ...(isProduction ? [] : ["'unsafe-eval'"]),
    ],
    // `next/font` injects a style element and the app uses inline `style` attributes; both fall
    // back to this directive. Unlike script-src, inline CSS is not an execution primitive in
    // any browser this app supports.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      ...connectOrigins(),
      'https://plausible.io',
      // Turbopack's HMR socket in development.
      ...(isProduction ? [] : ['ws:', 'wss:']),
    ],
  }

  // Would rewrite http://localhost:3003 to https:// in development and break every API call.
  if (isProduction) directives['upgrade-insecure-requests'] = []

  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(' ')}` : name))
    .join('; ')
}

const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: contentSecurityPolicy(),
  },
  {
    /**
     * Superseded by `frame-ancestors` in modern browsers, kept for the ones that only
     * implement this. `DENY` rather than `SAMEORIGIN`: nothing in this app frames itself.
     */
    key: 'X-Frame-Options',
    value: 'DENY',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    /**
     * Sends the full URL to same-origin requests, the origin alone cross-origin, and nothing
     * at all on an HTTPS→HTTP downgrade. `origin-when-cross-origin` — the value the Next.js
     * docs suggest — leaks the origin even to a downgraded destination.
     *
     * This matters concretely here: dashboard URLs carry endpoint UUIDs, and the billing
     * success page carries a payment reference.
     */
    key: 'Referrer-Policy',
    value: 'strict-origin-when-cross-origin',
  },
  {
    /**
     * `payment=()` is honest rather than cautious: every checkout is a redirect, so the
     * Payment Request API is never used. Remove the entry if an inline checkout is ever added.
     */
    key: 'Permissions-Policy',
    value:
      'accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()',
  },
  {
    /**
     * Severs `window.opener` for cross-origin navigations, so a page the user is redirected to
     * — a payment provider's checkout, say — cannot reach back into the tab it came from. Safe
     * with the redirect-based billing flow, which never depends on an opener reference.
     */
    key: 'Cross-Origin-Opener-Policy',
    value: 'same-origin',
  },
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'on',
  },
]

/**
 * Two years, subdomains included.
 *
 * **`preload` is deliberately not set.** Submitting a domain to the browser preload list is
 * close to irreversible — removal takes months to propagate through browser releases — and
 * with `includeSubDomains` it commits every current and future subdomain of the apex to
 * HTTPS-only, including ones that do not exist yet. That is an operator's decision to make
 * once they have confirmed no subdomain needs plain HTTP, not a default to inherit from a
 * config file. Append `; preload` here when that is true.
 *
 * Production only. Browsers ignore HSTS over an insecure transport anyway, so emitting it in
 * development would be noise at best.
 */
const strictTransportSecurity = {
  key: 'Strict-Transport-Security',
  value: 'max-age=63072000; includeSubDomains',
}

const nextConfig: NextConfig = {
  /** Removes `X-Powered-By: Next.js`. Version disclosure is free reconnaissance. */
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: isProduction
          ? [...securityHeaders, strictTransportSecurity]
          : securityHeaders,
      },
    ]
  },
}

export default nextConfig
