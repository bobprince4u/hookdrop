import { Response } from 'express'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { AuthRequest } from '../middleware/auth'
import { validatedQuery } from '../middleware/validate'
import { PLAN_IDS, type PlanId } from '../services/plan.service'
import type { AdminUserQuery } from '../validation/schemas'
import type { z } from 'zod'
import type { adminUpgradeSchema } from '../validation/schemas'

/**
 * Admin endpoints (H-33).
 *
 * These were three inline handlers in the routes file, each re-deriving its own
 * authorization from a raw `process.env.ADMIN_EMAIL` read. Authorization is now
 * `requireAdmin`, mounted ahead of every one of them, so none of this code runs for a
 * non-admin — the previous `/admin/upgrade-user` destructured the body and resolved
 * repositories *before* checking, which meant an unauthorized caller still drove work.
 *
 * The queries themselves were the finding:
 *
 *  - `/admin/users` joined `users × endpoints × events` unpaginated. One user with 10
 *    endpoints and 1 000 events each materialised 10 000 rows to produce two integers,
 *    and the row count multiplied across every user in the table.
 *  - `/admin/stats` issued ten separate unfiltered `COUNT(*)` queries per request.
 *
 * Both are now shaped so the work is proportional to what is returned.
 */

type AdminUpgradeInput = z.infer<typeof adminUpgradeSchema>

/**
 * Aggregates are cached briefly.
 *
 * Exact counts over `events` and `deliveries` are sequential scans in Postgres —
 * there is no way around that without switching to `reltuples` estimates, which would
 * change what the number means. The dashboard polls, so a short TTL removes the
 * repeat-scan cost without making the figures meaningfully stale, and it bounds what a
 * held admin session can cost the database.
 */
const STATS_TTL_MS = 30_000

interface StatsPayload {
  total_users: number
  free_users: number
  starter_users: number
  pro_users: number
  team_users: number
  total_events: number
  total_endpoints: number
  events_today: number
  total_deliveries: number
  failed_deliveries: number
}

let statsCache: { at: number; payload: StatsPayload } | null = null

/** `COUNT(*)` comes back from pg as a string, being `bigint`. */
const toInt = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? '0'), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

const collectStats = async (): Promise<StatsPayload> => {
  const db = AppDataSource

  /**
   * Four queries, not ten. The `FILTER` clauses let one pass over a table produce
   * several counts, so `events` and `deliveries` are each scanned once rather than
   * twice, and the five per-plan user counts become one grouped scan.
   */
  const [planRows, endpointRows, eventRows, deliveryRows] = await Promise.all([
    db.query<{ plan: string | null; count: string }[]>(
      'SELECT plan, COUNT(*)::text AS count FROM users GROUP BY plan'
    ),
    db.query<{ count: string }[]>(
      'SELECT COUNT(*)::text AS count FROM endpoints'
    ),
    db.query<{ total: string; today: string }[]>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '1 day')::text AS today
       FROM events`
    ),
    db.query<{ total: string; dead: string }[]>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'dead_letter')::text AS dead
       FROM deliveries`
    ),
  ])

  const byPlan = new Map(
    planRows.map((row) => [row.plan ?? 'free', toInt(row.count)])
  )
  const planCount = (plan: PlanId): number => byPlan.get(plan) ?? 0

  /**
   * Summed from the grouped rows rather than queried separately, so the total can
   * never disagree with its own breakdown. It also counts rows whose `plan` is null
   * or an unrecognised string, which a `WHERE plan = …` sum would have dropped.
   */
  const totalUsers = [...byPlan.values()].reduce((sum, n) => sum + n, 0)

  return {
    total_users: totalUsers,
    free_users: planCount('free'),
    starter_users: planCount('starter'),
    pro_users: planCount('pro'),
    team_users: planCount('team'),
    total_endpoints: toInt(endpointRows[0]?.count),
    total_events: toInt(eventRows[0]?.total),
    events_today: toInt(eventRows[0]?.today),
    total_deliveries: toInt(deliveryRows[0]?.total),
    failed_deliveries: toInt(deliveryRows[0]?.dead),
  }
}

export const getAdminStats = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) {
      res.json({ ...statsCache.payload, cached: true })
      return
    }

    const payload = await collectStats()
    statsCache = { at: Date.now(), payload }
    res.json({ ...payload, cached: false })
  } catch (error) {
    // Message only: a `QueryFailedError` carries the failing SQL and its bound parameters
    // (H-48), and these handlers bind an admin's search terms.
    console.error(
      'Admin stats error:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}

/** `%` and `_` are LIKE wildcards; a search for them should match literals. */
const escapeLike = (value: string): string =>
  value.replace(/([\\%_])/g, '\\$1')

export const listAdminUsers = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { page, limit, plan, search } = validatedQuery<AdminUserQuery>(req)

    const conditions: string[] = []
    const params: unknown[] = []

    if (plan && plan !== 'all' && (PLAN_IDS as readonly string[]).includes(plan)) {
      params.push(plan)
      conditions.push(`u.plan = $${params.length}`)
    }

    if (search) {
      params.push(`%${escapeLike(search)}%`)
      conditions.push(
        `(u.email ILIKE $${params.length} ESCAPE '\\' OR u.name ILIKE $${params.length} ESCAPE '\\')`
      )
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const [{ count: totalRaw }] = await AppDataSource.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM users u ${where}`,
      params
    )
    const total = toInt(totalRaw)

    /**
     * The page is selected first, then the two counts are computed per row of that
     * page. That is the whole fix: the old query joined every event of every user
     * into one result set to produce the same two integers, so its cost scaled with
     * the size of the `events` table rather than with the size of the response.
     * `limit` is capped at 100 by `paginationSchema`, so at most 100 users are
     * aggregated regardless of what the client asks for.
     */
    const pageParams = [...params, limit, (page - 1) * limit]

    const users = await AppDataSource.query(
      `WITH page AS (
         SELECT u.id, u.name, u.email, u.plan, u.payment_provider,
                u.plan_expires_at, u.created_at
         FROM users u
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}
       )
       SELECT p.*,
              (SELECT COUNT(*) FROM endpoints e WHERE e.user_id = p.id)::int
                AS endpoint_count,
              (SELECT COUNT(*)
                 FROM events ev
                 JOIN endpoints e2 ON e2.id = ev.endpoint_id
                WHERE e2.user_id = p.id)::int
                AS event_count
       FROM page p
       ORDER BY p.created_at DESC`,
      pageParams
    )

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (error) {
    console.error(
      'Admin users error:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const upgradeUser = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    // Validated by `adminUpgradeSchema`: `plan` is a known plan id and `days` is
    // bounded to 730, so a mistyped grant cannot hand out a century of free service.
    const { email, plan, days } = req.body as AdminUpgradeInput

    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({
      where: { email },
      select: { id: true, email: true },
    })

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    /**
     * Dated from now, not extended from any existing expiry: an admin grant is "this
     * user has N days from today", which is what the previous fixed 90-day literal
     * expressed. Paid renewals extend, and that logic lives in the billing webhook.
     *
     * An explicit date is required rather than null — `resolveEffectivePlan` treats a
     * paid plan with a null expiry as expired, deliberately, so that a cancellation
     * cannot read as a perpetual upgrade (H-30).
     */
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000)

    await userRepo.update(user.id, {
      plan,
      payment_provider: 'manual',
      plan_expires_at: expiresAt,
    })

    // The stats cache would otherwise report the old plan mix for up to its TTL.
    statsCache = null

    res.json({
      ok: true,
      message: `${user.email} upgraded to ${plan} for ${days} days`,
      plan,
      plan_expires_at: expiresAt.toISOString(),
    })
  } catch (error) {
    console.error(
      'Admin upgrade error:',
      error instanceof Error ? error.message : 'unknown error'
    )
    res.status(500).json({ error: 'Internal server error' })
  }
}
