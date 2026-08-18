import { create } from 'zustand'
import {
  api,
  describeApiError,
  endSession,
  getAccessToken,
  onSessionEnded,
  onSessionRefreshed,
  refreshSession,
  setAccessToken,
  type SessionEndReason,
  type SessionUser,
} from './api'

/**
 * Auth state (H-16, H-36, H-48).
 *
 * The store used to be the thing that wrote the access token to `localStorage` — in
 * `setAuth`, again in `refreshPlan`, and read back in `rehydrateAuth` through an
 * unguarded `JSON.parse` of whatever was under `hookdrop_user`, which throws on any
 * corrupted or hand-edited value and takes the dashboard down with it.
 *
 * Now the token lives in memory inside `./api` and the store holds only the profile the
 * UI renders. There is nothing left in `localStorage` to tamper with, corrupt, or steal:
 * the durable half of the session is the httpOnly refresh cookie, which JavaScript
 * cannot read.
 *
 * The consequence to keep in mind when reading components: a page load starts with
 * `status: 'loading'` and no user, because the session has to be restored over the
 * network. Gate on `status`, never on `user` alone, or a signed-in user gets a flash of
 * the signed-out UI.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthState {
  user: SessionUser | null
  status: AuthStatus
  planLoading: boolean
  setAuth: (user: SessionUser, accessToken: string) => void
  logout: () => Promise<void>
  isAuthenticated: () => boolean
  refreshPlan: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: 'loading',
  planLoading: false,

  /** Called by the login and register pages with the response they just received. */
  setAuth: (user, accessToken) => {
    setAccessToken(accessToken)
    set({ user, status: 'authenticated' })
  },

  /**
   * Revokes the session server-side before clearing it locally.
   *
   * Clearing local state alone left the refresh token valid until it expired — up to
   * thirty days of a session the user believed they had ended, which is the whole point
   * of a logout button.
   */
  logout: async () => {
    await endSession()
    set({ user: null, status: 'unauthenticated' })
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/login'
    }
  },

  isAuthenticated: () => get().status === 'authenticated',

  refreshPlan: async () => {
    if (get().status !== 'authenticated') return

    try {
      set({ planLoading: true })
      const res = await api.get('/api/billing/current')
      const currentPlan = res.data?.current_plan

      if (typeof currentPlan !== 'string') return

      const user = get().user
      if (user && user.plan !== currentPlan) {
        set({ user: { ...user, plan: currentPlan } })
      }
    } catch (error) {
      // Message only. The raw axios error carries the request's Authorization header.
      console.error('Plan refresh failed:', describeApiError(error))
    } finally {
      set({ planLoading: false })
    }
  },
}))

/**
 * Session ended under us — the refresh token expired, or its reuse was detected and the
 * backend revoked every session for the account.
 *
 * Registered at module scope rather than inside a component so it is armed as soon as
 * anything imports the store, including for requests fired during bootstrap.
 */
onSessionEnded((reason: SessionEndReason) => {
  useAuthStore.setState({ user: null, status: 'unauthenticated' })

  if (typeof window === 'undefined') return
  // Already on an auth page: no redirect, or the login form would reload under the user
  // mid-typing.
  if (window.location.pathname.startsWith('/auth/')) return

  const label = reason === 'revoked' ? 'session_revoked' : 'session_expired'
  window.location.href = `/auth/login?reason=${label}`
})

/**
 * A refresh succeeded, from bootstrap or from a retried 401. The response carries the
 * server's current view of the account, so this is also how a plan change made by a
 * webhook reaches the UI without a page reload.
 */
onSessionRefreshed((user: SessionUser) => {
  useAuthStore.setState({ user, status: 'authenticated' })
})

let bootstrap: Promise<void> | null = null

const restoreSession = async (): Promise<void> => {
  if (getAccessToken()) {
    useAuthStore.setState({ status: 'authenticated' })
    return
  }

  const outcome = await refreshSession()
  if (outcome.ok) return // `onSessionRefreshed` has already set the state.

  /**
   * `unavailable` lands here too — a refresh that could not reach the API is reported as
   * unauthenticated, which sends the user to the login page rather than leaving them on
   * a dashboard that cannot load anything. They find out why when the login call fails
   * with the same error.
   */
  useAuthStore.setState({ user: null, status: 'unauthenticated' })
}

/**
 * Restores the session from the refresh cookie. Safe to call from any number of
 * components and from a `StrictMode` double-invoked effect: the work happens once per
 * page load, and concurrent callers share `refreshSession`'s single flight.
 */
export const rehydrateAuth = (): Promise<void> => {
  bootstrap ??= restoreSession()
  return bootstrap
}
