import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
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
  authors: [{ name: 'Hookdropi' }],
  creator: 'Hookdropi',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://hookdrop.dev',
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
    google: 'googlea3077b581a706883.html',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <script
          async
          src="https://plausible.io/js/pa-nTDBF4GUfeEH8BltPUNve.js"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)};
              plausible.init=plausible.init||function(i){plausible.o=i||{}};
              plausible.init();
            `,
          }}
        />
      </head>
      <body className={geist.className}>{children}</body>
    </html>
  )
}
