import { Router } from 'express'

import {
  authenticate,
  denyApiKeyAuth,
  loadCurrentUser,
  requireAdmin,
  requirePlan,
} from '../middleware/auth'
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../middleware/validate'
import {
  aiRateLimiter,
  loginRateLimiter,
  publicRateLimiter,
  refreshRateLimiter,
  registerRateLimiter,
  replayRateLimiter,
} from '../middleware/rateLimiter'

import {
  login,
  logout,
  logoutAll,
  refresh,
  register,
} from '../controllers/auth.controller'
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  updateEndpoint,
} from '../controllers/endpoints.controller'
import {
  createDestination,
  deleteDestination,
  listDestinations,
} from '../controllers/destinations.controller'
import {
  getEvent,
  getEventDeliveries,
  listEvents,
  replayEvent,
} from '../controllers/events.controller'
import {
  diagnoseFailure,
  explainPayload,
  generateHandler,
  generateSchema,
} from '../controllers/ai.controller'
import {
  getCurrentPlan,
  getPlans,
  initializePayment,
  verifyPayment,
} from '../controllers/billing.controller'
import {
  getAdminStats,
  listAdminUsers,
  upgradeUser,
} from '../controllers/admin.controller'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../controllers/apiKeys.controller'
import { getDemoEvents, getRates } from '../controllers/public.controller'
import { submitFeedback } from '../controllers/feedback.controller'

import {
  adminUpgradeSchema,
  adminUserQuerySchema,
  apiKeyParamsSchema,
  createApiKeySchema,
  createDestinationSchema,
  createEndpointSchema,
  destinationParamsSchema,
  endpointParamsSchema,
  eventParamsSchema,
  eventQuerySchema,
  feedbackSchema,
  generateHandlerSchema,
  initializePaymentSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  updateEndpointSchema,
} from '../validation/schemas'

/**
 * API route table.
 *
 * Every limiter, validator and authorization middleware in this service already
 * existed and none of them were mounted — this file imported `authenticate` and
 * nothing else, which is why H-07, H-14, H-20, H-24, H-25, H-26 and H-32 all reduced
 * to "written but dangling". Mounting them is the fix for all of those at once.
 *
 * Four handlers were also defined inline here, with their own ad-hoc authorization and
 * their own database queries. They now live in `admin.controller.ts`,
 * `public.controller.ts` and `feedback.controller.ts`, so this file is a route table
 * and nothing else.
 *
 * ## Middleware order
 *
 * 1. `authenticate` — 401 first. An unauthenticated caller drives no work and learns
 *    nothing about a route's shape, not even its parameter format.
 * 2. limiter — placed after `authenticate` so per-user buckets can key on the user id
 *    (`userOrIpKey`), and before anything else so a throttled request costs no
 *    database work. Public routes have no step 1, so their limiter comes first.
 * 3. `validateParams` — a malformed uuid is rejected before it reaches Postgres.
 * 4. `loadCurrentUser` — the authoritative user row, mounted only where entitlement or
 *    profile data is actually needed rather than on everything.
 * 5. `requirePlan` / `requireAdmin` — authorization, always **before** the body is
 *    read. The old `/admin/upgrade-user` destructured the body and resolved
 *    repositories first and only then compared emails (H-33).
 * 6. `denyApiKeyAuth` — on the routes where holding an API key must not be sufficient:
 *    session revocation, key management, payment initiation, plan grants. Mounted after
 *    `authenticate`, which is what records the credential type (H-27).
 * 7. `validateBody` / `validateQuery`.
 * 8. handler.
 *
 * This deviates from the order sketched in the plan, which put `validateParams` ahead
 * of `authenticate`: a 400 describing the expected parameter format is a response an
 * anonymous caller should not be able to elicit. The property that mattered —
 * authorization before any body destructuring or repository work — holds either way.
 *
 * ## Removed
 *
 *  - `POST /billing/webhook`. `index.ts` mounts the same path app-level with
 *    `express.raw()` *before* this router, so that registration always won and this
 *    one was unreachable. Keeping a dead copy of a signature-verified route next to
 *    the live one only invites someone to "fix" the wrong one.
 *  - `GET /billing/mode`. It read `PAYMENT_MODE`, which no longer exists in the
 *    validated config, and told users payments were in test mode and the Pro plan was
 *    free — while the live payment providers took real money.
 *  - `GET /test-sentry`. A public, unauthenticated route whose entire purpose was to
 *    throw. Verify error reporting from a deploy log, not from a route strangers can
 *    call.
 */
const router = Router()

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

router.post(
  '/auth/register',
  registerRateLimiter,
  validateBody(registerSchema),
  register
)

router.post('/auth/login', loginRateLimiter, validateBody(loginSchema), login)

/**
 * The refresh token normally arrives in an httpOnly cookie, so the body is optional
 * and `.default({})` keeps a bodyless request valid — without it, a POST carrying no
 * `Content-Type` leaves `req.body` undefined in Express 5 and the schema would reject
 * the browser's own refresh call.
 */
router.post(
  '/auth/refresh',
  refreshRateLimiter,
  validateBody(refreshSchema.default({})),
  refresh
)

/**
 * Unauthenticated on purpose. Logout clears the cookie and revokes whatever token was
 * presented; requiring a valid *access* token would mean an expired session could not
 * be logged out, which is precisely when a user wants to.
 */
router.post('/auth/logout', logout)

/** Revokes every session for the account, so it must prove which account that is. */
router.post('/auth/logout-all', authenticate, denyApiKeyAuth, logoutAll)

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Programmatic credentials (H-27).
 *
 * `denyApiKeyAuth` on all three: a key must not be able to issue another key, revoke a
 * sibling, or enumerate the account's credentials. Without it, one leaked key stops being a
 * revocable loss of API access and becomes persistent access that survives revoking it —
 * whoever holds it just mints a replacement first.
 *
 * No dedicated limiter. Creation is bounded by the active-key cap the service enforces, and
 * the app-level `apiRateLimiter` already covers the create-then-revoke loop that would
 * otherwise get around it.
 */
router.post(
  '/keys',
  authenticate,
  denyApiKeyAuth,
  validateBody(createApiKeySchema),
  createApiKey
)

router.get('/keys', authenticate, denyApiKeyAuth, listApiKeys)

router.delete(
  '/keys/:id',
  authenticate,
  denyApiKeyAuth,
  validateParams(apiKeyParamsSchema),
  revokeApiKey
)

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

router.get('/endpoints', authenticate, listEndpoints)

/** `loadCurrentUser` supplies the effective plan the endpoint cap is read from (H-26). */
router.post(
  '/endpoints',
  authenticate,
  loadCurrentUser,
  validateBody(createEndpointSchema),
  createEndpoint
)

router.get(
  '/endpoints/:id',
  authenticate,
  validateParams(endpointParamsSchema),
  getEndpoint
)

router.patch(
  '/endpoints/:id',
  authenticate,
  validateParams(endpointParamsSchema),
  validateBody(updateEndpointSchema),
  updateEndpoint
)

router.delete(
  '/endpoints/:id',
  authenticate,
  validateParams(endpointParamsSchema),
  deleteEndpoint
)

/* -------------------------------------------------------------------------- */
/* Destinations                                                               */
/* -------------------------------------------------------------------------- */

router.get(
  '/endpoints/:id/destinations',
  authenticate,
  validateParams(endpointParamsSchema),
  listDestinations
)

router.post(
  '/endpoints/:id/destinations',
  authenticate,
  validateParams(endpointParamsSchema),
  validateBody(createDestinationSchema),
  createDestination
)

router.delete(
  '/endpoints/:id/destinations/:dId',
  authenticate,
  validateParams(destinationParamsSchema),
  deleteDestination
)

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `validateQuery` is not optional here. `listEvents` reads its filters through
 * `validatedQuery()`, which throws by design when the middleware is absent — so this
 * route returned 500 on every single call while the validator sat unmounted (H-20).
 */
router.get(
  '/endpoints/:id/events',
  authenticate,
  validateParams(endpointParamsSchema),
  validateQuery(eventQuerySchema),
  listEvents
)

router.get(
  '/endpoints/:id/events/:eId',
  authenticate,
  validateParams(eventParamsSchema),
  getEvent
)

/** Replay enqueues delivery work, so it gets the tighter bucket. */
router.post(
  '/endpoints/:id/events/:eId/replay',
  authenticate,
  replayRateLimiter,
  validateParams(eventParamsSchema),
  replayEvent
)

router.get(
  '/endpoints/:id/events/:eId/deliveries',
  authenticate,
  validateParams(eventParamsSchema),
  getEventDeliveries
)

/* -------------------------------------------------------------------------- */
/* AI                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Shared chain for the four AI routes.
 *
 * `requirePlan('starter')` and the `ai_enabled` check inside the controller are both
 * kept. They are not duplicates: the middleware refuses on plan *rank* before any
 * endpoint or event row is read, while the controller enforces the plan's `ai_enabled`
 * capability flag, which is what actually governs the feature. The middleware saves the
 * queries; the flag decides the answer.
 *
 * Both read `req.effectivePlan`, so an expired subscription stops generating billable
 * model calls the moment it lapses — the old check consulted the stored `plan` column
 * and ignored `plan_expires_at` entirely (H-14).
 */
const aiChain = [
  authenticate,
  aiRateLimiter,
  validateParams(eventParamsSchema),
  loadCurrentUser,
  requirePlan('starter'),
] as const

router.get('/endpoints/:id/events/:eId/ai/explain', ...aiChain, explainPayload)

router.get('/endpoints/:id/events/:eId/ai/schema', ...aiChain, generateSchema)

router.post(
  '/endpoints/:id/events/:eId/ai/handler',
  ...aiChain,
  validateBody(generateHandlerSchema),
  generateHandler
)

router.get('/endpoints/:id/events/:eId/ai/diagnose', ...aiChain, diagnoseFailure)

/* -------------------------------------------------------------------------- */
/* Billing                                                                    */
/* -------------------------------------------------------------------------- */

/** Public: the pricing page reads both before anyone has an account. */
router.get('/billing/plans', publicRateLimiter, getPlans)
router.get('/billing/rates', publicRateLimiter, getRates)

/**
 * No `loadCurrentUser` on either of these: both handlers already load the user row
 * themselves — `getCurrentPlan` to resolve the effective plan, `initializePayment` to
 * price from the server catalogue — so mounting it would add a second identical query.
 */
router.get('/billing/current', authenticate, getCurrentPlan)

/**
 * `denyApiKeyAuth`: starting a payment is a money-moving operation, and it is initiated by a
 * person choosing a plan, never by an integration. A key that could do this could redirect a
 * customer's card into a checkout they did not ask for (H-27).
 */
router.post(
  '/billing/initialize',
  authenticate,
  denyApiKeyAuth,
  validateBody(initializePaymentSchema),
  initializePayment
)

/**
 * Authenticated because the answer is scoped to the caller's own intent rows, and that
 * scoping is what stops `?reference=anything` from rendering a success screen (H-28).
 * No `validateQuery`: the handler reads `reference`/`session_id` defensively and bounds
 * the length itself, so it is correct with or without a validator in front of it.
 */
router.get('/billing/verify', authenticate, verifyPayment)

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `requireAdmin` replaces three separate inline `req.user.email !== process.env.ADMIN_EMAIL`
 * comparisons. Those were the third of three disagreeing readers of the admin address
 * — this file read `process.env.ADMIN_EMAIL`, `requireAdmin` read `ADMIN_EMAILS`, and
 * the email service read `env.ADMIN_EMAIL` — which is why every admin route 403'd for
 * everyone (H-31). It also fails closed on an empty allow-list, where `undefined !==
 * undefined` had been doing the denying by coincidence.
 */
router.get('/admin/stats', authenticate, requireAdmin, getAdminStats)

router.get(
  '/admin/users',
  authenticate,
  requireAdmin,
  validateQuery(adminUserQuerySchema),
  listAdminUsers
)

/**
 * `denyApiKeyAuth` on the mutation only. Granting plan time is giving away paid service, so it
 * requires an interactive admin session; the two read-only admin routes above are content with
 * either credential, since a key that can read the admin dashboard can already read everything
 * the account owns.
 */
router.post(
  '/admin/upgrade-user',
  authenticate,
  requireAdmin,
  denyApiKeyAuth,
  validateBody(adminUpgradeSchema),
  upgradeUser
)

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

/** `loadCurrentUser` is what supplies a real name instead of the uuid the old call
 * site passed in the `userName` position (H-23). */
router.post(
  '/feedback',
  authenticate,
  loadCurrentUser,
  validateBody(feedbackSchema),
  submitFeedback
)

/* -------------------------------------------------------------------------- */
/* Public demo                                                                */
/* -------------------------------------------------------------------------- */

router.get('/demo/events', publicRateLimiter, getDemoEvents)

/**
 * Exported last, after every route is registered.
 *
 * This is not cosmetic. The previous file placed `export default router` in the middle,
 * with `/demo/events` registered below it — which happened to work, since the export is
 * a live binding to a mutable Router, but it reads as though the routes after it are
 * dead and invites someone to delete them.
 */
export default router
