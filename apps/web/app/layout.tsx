import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Script from 'next/script'
import './globals.css'

const geist = Geist({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: {
    default: 'Hookdropi — AI-Native Webhook Relay & Inspector',
    template: '%s | Hookdropi',
  },
  description:
    'Capture every webhook, inspect the payload, forward to any environment, and replay on demand. AI explains what arrived and why it failed.',
  keywords: [
    'webhook',
    'webhook inspector',
    'webhook relay',
    'webhook debugger',
    'stripe webhooks',
    'paystack webhooks',
    'developer tools',
    'AI webhook',
  ],
  authors: [{ name: 'Bobprince' }],
  creator: 'Bobprince',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://hookdrop.qzz.io',
    title: 'Hookdropi — AI-Native Webhook Relay & Inspector',
    description: 'Never lose a webhook. Never debug one in the dark.',
    siteName: 'Hookdropi',
    images: [
      {
        url: '/hookdroplogo.png',
        width: 512,
        height: 512,
        alt: 'Hookdropi',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Hookdropi — AI-Native Webhook Relay & Inspector',
    description: 'Never lose a webhook. Never debug one in the dark.',
    images: ['/hookdroplogo.png'],
  },
  icons: {
    icon: '/favicon.png',
    apple: '/favicon.png',
  },
  verification: {
    google: 'a3077b581a706883',
  },
}

/**
 * Third-party scripts (H-42).
 *
 * Both Plausible tags were raw `<script>` elements in `<head>`, which is what `next/script`
 * exists to replace: Next.js cannot dedupe, order, or defer a tag it does not own, and the
 * inline one had no `id`, which the Script component requires in order to track it.
 *
 * `strategy` is the default `afterInteractive` for both. The queue shim is declared first so
 * that any `plausible(...)` call made before the remote script arrives is buffered rather than
 * thrown away — previously it sat *after* an `async` script tag and only worked because an
 * async script cannot block the parser.
 *
 * **`https://checkout.flutterwave.com/v3.js` was removed.** It loaded on every route,
 * marketing pages included, and nothing ever called `FlutterwaveCheckout`: every provider's
 * checkout is a full-page redirect to `authorization_url` (`app/dashboard/billing/page.tsx`).
 * It was a third-party script on every page load with no feature behind it, and dropping it
 * takes a host out of the CSP as well. If an inline Flutterwave checkout is added later, load
 * it from the billing route's own layout — not from here — and allow-list the host in
 * `next.config.ts`.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={geist.className}>
        {children}
        <Script id="plausible-init">
          {`window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)};
plausible.init=plausible.init||function(i){plausible.o=i||{}};
plausible.init();`}
        </Script>
        <Script src="https://plausible.io/js/pa-nTDBF4GUfeEH8BltPUNve.js" />
      </body>
    </html>
  )
}
