import { Request, Response } from 'express'
import axios from 'axios'
import { AppDataSource } from '../db'
import { env } from '../config/env'
import { redactSensitiveHeaders } from '../services/headers.util'

/**
 * Unauthenticated public routes: the currency table the pricing page reads, and the
 * live demo feed the marketing page polls.
 *
 * Both were inline handlers in the routes file, both unthrottled, and both are now
 * behind `publicRateLimiter`. Beyond that:
 *
 *  - `/billing/rates` called Flutterwave's FX API on every single request, with no
 *    timeout and no cache, so an unauthenticated visitor could drive one outbound
 *    request per page load through our provider credential (H-07/H-24). Its fallback
 *    table was also hardcoded twice, in two places that could drift apart.
 *  - `/demo/events` interpolated a hardcoded `'demo-hookdrop-live-2024'` token into
 *    the SQL, alongside an `env.DEMO_PUBLIC_TOKEN` that nothing read (H-24).
 */

/**
 * Fallback rates, derived from one configured number.
 *
 * `NGN_PER_USD` is the same value the Stripe provider prices against, so the pricing
 * page and the checkout session cannot disagree about the dollar rate. EUR and GBP are
 * fixed multiples of it, chosen to reproduce the previously hardcoded 1750 and 2050
 * exactly at the default rate of 1600 — so nothing changes on deploy, but correcting
 * the rate now moves all three together instead of leaving two stale literals behind.
 */
const EUR_PER_USD = 1.09375
const GBP_PER_USD = 1.28125

const fallbackRates = (): Record<string, number> => ({
  NGN: 1,
  USD: env.NGN_PER_USD,
  EUR: Math.round(env.NGN_PER_USD * EUR_PER_USD),
  GBP: Math.round(env.NGN_PER_USD * GBP_PER_USD),
})

const FX_CURRENCIES = ['USD', 'EUR', 'GBP'] as const

/** Live rates are cached for ten minutes; a failed lookup for one, so a provider
 * outage does not turn every page load into a fresh timeout. */
const RATES_TTL_MS = 10 * 60 * 1000
const RATES_ERROR_TTL_MS = 60 * 1000
const FX_TIMEOUT_MS = 4_000

let ratesCache: {
  at: number
  ttl: number
  rates: Record<string, number>
  source: 'live' | 'fallback'
} | null = null

const fetchRate = async (currency: string): Promise<number | null> => {
  try {
    const response = await axios.get(
      'https://api.flutterwave.com/v3/fx-rates',
      {
        params: { from: currency, to: 'NGN', amount: 1 },
        headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` },
        timeout: FX_TIMEOUT_MS,
      }
    )

    /**
     * Checked rather than trusted. `response.data.data.rate` was read straight into
     * the response before, so a shape change upstream produced `undefined` and the
     * pricing page rendered `null` as a price.
     */
    const rate = Number(response.data?.data?.rate)
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch {
    // Deliberately quiet: this is an expected failure on a public route, and the
    // error object carries the request headers, which hold the provider key (H-48).
    return null
  }
}

export const getRates = async (_req: Request, res: Response): Promise<void> => {
  if (ratesCache && Date.now() - ratesCache.at < ratesCache.ttl) {
    res.json({
      rates: ratesCache.rates,
      base: 'NGN',
      source: ratesCache.source,
      cached: true,
    })
    return
  }

  const rates = fallbackRates()
  let live = 0

  // No credential means no lookup. Previously this sent `Bearer undefined` and
  // waited for the 401.
  if (env.FLUTTERWAVE_SECRET_KEY) {
    const results = await Promise.all(
      FX_CURRENCIES.map(async (currency) => ({
        currency,
        rate: await fetchRate(currency),
      }))
    )

    for (const { currency, rate } of results) {
      if (rate !== null) {
        rates[currency] = rate
        live += 1
      }
    }
  }

  const source = live === FX_CURRENCIES.length ? 'live' : 'fallback'
  ratesCache = {
    at: Date.now(),
    ttl: source === 'live' ? RATES_TTL_MS : RATES_ERROR_TTL_MS,
    rates,
    source,
  }

  res.json({ rates, base: 'NGN', source, cached: false })
}

/**
 * Public demo feed.
 *
 * Fixed page size: no caller selects it, and leaving it client-controlled on an
 * unauthenticated route would just be an unpaginated read with extra steps.
 */
const DEMO_EVENT_LIMIT = 20

/**
 * Bodies are capped at the same 16 KB the demo submission schema allows, so a payload
 * posted within the documented demo limit is never truncated — but a multi-megabyte
 * body sent straight to the demo ingest URL cannot be amplified to every visitor.
 */
const DEMO_BODY_MAX_CHARS = 16_384

interface DemoEventRow {
  id: string
  method: string
  body: string | null
  headers: unknown
  source_ip: string | null
  status: string
  received_at: Date
}

export const getDemoEvents = async (
  _req: Request,
  res: Response
): Promise<void> => {
  try {
    /**
     * The token and the retention window are both parameters now. The window shares
     * `DEMO_RETENTION_HOURS` with the demo cleanup job, so the feed cannot advertise
     * events the cleanup has already deleted, or hide ones it has not.
     */
    const cutoff = new Date(
      Date.now() - env.DEMO_RETENTION_HOURS * 60 * 60 * 1000
    )

    const events = await AppDataSource.query<DemoEventRow[]>(
      `SELECT e.id, e.method, e.body, e.headers, e.source_ip, e.status, e.received_at
         FROM events e
         JOIN endpoints ep ON ep.id = e.endpoint_id
        WHERE ep.public_token = $1
          AND e.received_at > $2
        ORDER BY e.received_at DESC
        LIMIT $3`,
      [env.DEMO_PUBLIC_TOKEN, cutoff, DEMO_EVENT_LIMIT]
    )

    /**
     * Headers are redacted on the way out (H-17). This is the one route that serves
     * captured headers to anyone at all, and the rows it reads were written before any
     * write-path redaction existed, so read-time redaction is what covers them.
     */
    res.json({
      events: events.map((event) => ({
        ...event,
        body: event.body?.slice(0, DEMO_BODY_MAX_CHARS) ?? null,
        headers: redactSensitiveHeaders(event.headers),
      })),
    })
  } catch (error) {
    console.error('Demo events error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
