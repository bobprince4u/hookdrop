import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'

/**
 * The API client, and the only place an access token is ever held (H-16, H-48).
 *
 * ## What was wrong
 *
 * The access token was read from `localStorage` on every request and written there by
 * the auth store. `localStorage` is readable by any script that runs on the origin, so
 * a single XSS — in this app, in a dependency, in a third-party tag — exfiltrates a
 * bearer token for the API. The 401 handler then cleared storage and hard-navigated to
 * `/auth/login`, and **no refresh call existed anywhere in the frontend**: the backend
 * grew rotating refresh tokens and an httpOnly cookie, and the browser never used them.
 * With a 15-minute access token that meant every session died after fifteen minutes,
 * mid-action, with no way back except signing in again.
 *
 * The base URL was also logged to the console on every page load.
 *
 * ## What replaces it
 *
 * The access token lives in a module-scoped variable — memory only, gone on reload, not
 * reachable through `localStorage`, `sessionStorage`, or a cookie. The refresh token is
 * never seen by JavaScript at all: it is an httpOnly cookie scoped to `/api/auth`, which
 * is why `withCredentials` is set here and why the browser does not attach it to any
 * other API route.
 *
 * A page load therefore starts with no token, and `rehydrateAuth` in `./auth` restores
 * the session by calling refresh once. Any request that races that bootstrap gets a 401,
 * joins the same single-flight refresh, and is retried — so the race resolves itself
 * instead of bouncing the user to the login page.
 *
 * ## Single-flight, and why a lock as well
 *
 * Ten requests failing with 401 at once must produce **one** refresh call, not ten.
 * Ten calls would consume ten rotations, and the backend treats a second presentation of
 * an already-rotated token as theft (`token.service.ts`) — so a naive implementation
 * revokes every session on the user's own devices under nothing more than page load.
 * `inFlightRefresh` is that guard within a tab; every concurrent caller awaits the same
 * promise, which is the queue.
 *
 * Two *tabs* are the same hazard across process boundaries, and a promise cannot span
 * them. `navigator.locks` serialises the refresh across all tabs of the origin, so the
 * second tab runs after the first has finished and its cookie has been replaced — it
 * presents the new token and rotates normally. Where the Web Locks API is missing the
 * client falls back to unlocked behaviour, and the backend's own race window
 * (`ROTATION_RACE_WINDOW_MS`) catches what is left: a loser is answered `refresh_race`,
 * nothing is revoked, and the retry below succeeds.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL!

const REFRESH_PATH = '/api/auth/refresh'
const LOGOUT_PATH = '/api/auth/logout'

/**
 * A 401 from these is an answer, not an expired session. Refreshing on a failed login
 * would turn a wrong password into a token rotation, and refreshing on a failed refresh
 * is an infinite loop.
 */
const NON_REFRESHABLE_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  REFRESH_PATH,
  LOGOUT_PATH,
])

/** Cross-tab lock name. Namespaced because the lock scope is the whole origin. */
const REFRESH_LOCK = 'hookdrop:refresh'

/**
 * Long enough for the winning tab's `Set-Cookie` to have been applied, short enough
 * that the user does not notice. Only ever waited once.
 */
const RACE_RETRY_DELAY_MS = 250

export interface SessionUser {
  id: string
  email: string
  name: string
  plan: string
}

/** Why a session stopped being valid. `revoked` means reuse was detected server-side. */
export type SessionEndReason = 'expired' | 'revoked'

/**
 * `unavailable` is deliberately distinct from `expired`: a refresh that failed because
 * the network is down, or because the API returned a 500, says nothing about whether the
 * session is still good, and must not sign the user out.
 */
export type RefreshOutcome =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: SessionEndReason | 'unavailable' }

/* -------------------------------------------------------------------------- */
/* The token                                                                  */
/* -------------------------------------------------------------------------- */

let accessToken: string | null = null

export const getAccessToken = (): string | null => accessToken

export const setAccessToken = (token: string | null): void => {
  accessToken = token
}

/* -------------------------------------------------------------------------- */
/* Clients                                                                    */
/* -------------------------------------------------------------------------- */

export const api = axios.create({
  baseURL: API_URL,
  // Sends the httpOnly refresh cookie. The cookie's path is `/api/auth`, so the browser
  // only attaches it to the auth routes — it is not broadcast to every API call.
  withCredentials: true,
})

/**
 * A second instance with **no interceptors**, used for refresh and logout.
 *
 * The refresh call cannot go through the client whose 401 handler calls refresh.
 */
const sessionClient = axios.create({
  baseURL: API_URL,
  withCredentials: true,
})

/* -------------------------------------------------------------------------- */
/* Session lifecycle callbacks                                                */
/* -------------------------------------------------------------------------- */

/**
 * `./auth` registers these. Inverting the dependency keeps the store out of this module,
 * which would otherwise be an import cycle: the store already imports `api`.
 */
let sessionRefreshedHandler: ((user: SessionUser) => void) | null = null
let sessionEndedHandler: ((reason: SessionEndReason) => void) | null = null

export const onSessionRefreshed = (
  handler: (user: SessionUser) => void
): void => {
  sessionRefreshedHandler = handler
}

export const onSessionEnded = (
  handler: (reason: SessionEndReason) => void
): void => {
  sessionEndedHandler = handler
}

/* -------------------------------------------------------------------------- */
/* Refresh                                                                    */
/* -------------------------------------------------------------------------- */

type LockRunner = <T>(name: string, callback: () => Promise<T>) => Promise<T>

/**
 * Feature-detected rather than typed against `LockManager`, so this compiles and runs
 * whatever the DOM lib and the browser support. No lock is a degradation, not a failure.
 */
const lockRunner = (): LockRunner | null => {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as unknown as { locks?: { request?: unknown } }).locks
  if (locks && typeof locks.request === 'function') {
    return locks.request.bind(locks) as LockRunner
  }
  return null
}

const isSessionUser = (value: unknown): value is SessionUser => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.plan === 'string'
  )
}

type RefreshAttempt =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: SessionEndReason | 'unavailable' | 'race' }

const postRefresh = async (): Promise<RefreshAttempt> => {
  try {
    const { data } = await sessionClient.post(REFRESH_PATH)
    const token = (data as { accessToken?: unknown } | undefined)?.accessToken
    const user = (data as { user?: unknown } | undefined)?.user

    if (typeof token !== 'string' || !isSessionUser(user)) {
      // A 200 that does not carry a session is a broken deployment, not an ended
      // session, and must not be reported as one.
      return { ok: false, reason: 'unavailable' }
    }

    accessToken = token
    return { ok: true, user }
  } catch (error) {
    if (!axios.isAxiosError(error) || !error.response) {
      // Offline, DNS failure, CORS rejection. The session is probably still valid.
      return { ok: false, reason: 'unavailable' }
    }

    if (error.response.status !== 401) {
      return { ok: false, reason: 'unavailable' }
    }

    const code = (error.response.data as { code?: unknown } | undefined)?.code
    if (code === 'refresh_race') return { ok: false, reason: 'race' }
    if (code === 'refresh_token_reuse') return { ok: false, reason: 'revoked' }
    return { ok: false, reason: 'expired' }
  }
}

const attemptRefresh = async (): Promise<RefreshOutcome> => {
  let attempt = await postRefresh()

  if (!attempt.ok && attempt.reason === 'race') {
    await new Promise((resolve) => setTimeout(resolve, RACE_RETRY_DELAY_MS))
    attempt = await postRefresh()
  }

  if (attempt.ok) {
    sessionRefreshedHandler?.(attempt.user)
    return { ok: true, user: attempt.user }
  }

  // A race that loses twice is treated as "could not refresh", never as "signed out":
  // the cookie in this browser is somebody else's valid token.
  const reason = attempt.reason === 'race' ? 'unavailable' : attempt.reason

  if (reason !== 'unavailable') {
    accessToken = null
    sessionEndedHandler?.(reason)
  }

  return { ok: false, reason }
}

let inFlightRefresh: Promise<RefreshOutcome> | null = null

/**
 * Refreshes the session, at most once at a time per tab and once at a time per origin.
 *
 * Callers are the 401 interceptor below and `rehydrateAuth` in `./auth`; both share the
 * same in-flight promise, which is what makes a page load that fires several requests
 * before bootstrap finishes cost exactly one rotation.
 */
export const refreshSession = (): Promise<RefreshOutcome> => {
  if (inFlightRefresh) return inFlightRefresh

  const lock = lockRunner()
  const run = lock
    ? lock(REFRESH_LOCK, attemptRefresh)
    : attemptRefresh()

  inFlightRefresh = run.finally(() => {
    inFlightRefresh = null
  })

  return inFlightRefresh
}

/** Revokes the current session server-side and drops the in-memory token. */
export const endSession = async (): Promise<void> => {
  try {
    await sessionClient.post(LOGOUT_PATH)
  } catch {
    // Logout is best-effort by design: the endpoint is idempotent and unauthenticated,
    // and a network failure must not leave the user stuck on a page they wanted to
    // leave. The local token is dropped either way.
  } finally {
    accessToken = null
  }
}

/* -------------------------------------------------------------------------- */
/* Interceptors                                                               */
/* -------------------------------------------------------------------------- */

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

interface RetriableRequest extends InternalAxiosRequestConfig {
  /** Set once a request has been replayed after a refresh, so it can never loop. */
  _refreshRetried?: boolean
}

const pathOf = (url: string | undefined): string => {
  if (!url) return ''
  const [withoutQuery] = url.split('?')
  return withoutQuery
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as RetriableRequest | undefined

    if (
      error.response?.status !== 401 ||
      !config ||
      config._refreshRetried ||
      NON_REFRESHABLE_PATHS.has(pathOf(config.url))
    ) {
      return Promise.reject(error)
    }

    const outcome = await refreshSession()
    if (!outcome.ok) {
      // `attemptRefresh` has already notified the store when the session actually
      // ended. Rejecting here lets the calling component render its own error.
      return Promise.reject(error)
    }

    config._refreshRetried = true
    return api(config)
  }
)

/* -------------------------------------------------------------------------- */
/* Error text                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A safe message for a failed request (H-48).
 *
 * `console.error(err)` on an axios error prints the whole error object, and an axios
 * error carries `config.headers` — which is to say the `Authorization` header of the
 * request that failed. Anyone with the devtools console open, and any log collector
 * wired to it, gets a bearer token. Raw response payloads have the same problem in
 * reverse: they can quote back whatever the caller sent.
 *
 * This returns the server's own `error` string when there is one, and a status line
 * otherwise. Nothing else from the error is exposed.
 */

/** Bound on rendered text, so a hostile or broken response cannot fill the page. */
const MAX_MESSAGE_LENGTH = 300

interface ValidationDetail {
  field?: unknown
  message?: unknown
}

/**
 * `validateBody` answers `{ error: 'Validation failed', details: [{field, message}] }`,
 * so the top-level string alone would tell a user only that *something* was wrong with
 * a form they cannot see the rules for — "Validation failed" in place of "Password must
 * be at least 12 characters".
 *
 * Safe to render: `middleware/validate.ts` deliberately lists field names and messages
 * and never the submitted values, precisely so this text can be shown and logged.
 */
const describeValidationDetails = (data: unknown): string | null => {
  const details = (data as { details?: unknown } | undefined)?.details
  if (!Array.isArray(details) || details.length === 0) return null

  const messages = (details as ValidationDetail[])
    .map((detail) => (typeof detail?.message === 'string' ? detail.message : null))
    .filter((message): message is string => message !== null && message.length > 0)

  if (messages.length === 0) return null
  return messages.slice(0, 3).join('. ').slice(0, MAX_MESSAGE_LENGTH)
}

export const describeApiError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data

    const validation = describeValidationDetails(data)
    if (validation) return validation

    const message = (data as { error?: unknown } | undefined)?.error
    if (
      typeof message === 'string' &&
      message.length > 0 &&
      message.length <= MAX_MESSAGE_LENGTH
    ) {
      return message
    }
    if (error.response) return `Request failed with status ${error.response.status}`
    return 'Could not reach the API'
  }
  return 'Something went wrong'
}
