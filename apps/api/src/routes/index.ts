import { Router } from 'express'
import { authenticate } from '../middleware/auth'
import { register, login, refresh } from '../controllers/auth.controller'
import {
  listEndpoints,
  createEndpoint,
  getEndpoint,
  updateEndpoint,
  deleteEndpoint,
} from '../controllers/endpoints.controller'
import {
  listDestinations,
  createDestination,
  deleteDestination,
} from '../controllers/destinations.controller'
import {
  listEvents,
  getEvent,
  replayEvent,
  getEventDeliveries,
} from '../controllers/events.controller'
import {
  explainPayload,
  generateSchema,
  generateHandler,
  diagnoseFailure,
} from '../controllers/ai.controller'
import {
  getPlans,
  initializePayment,
  handleWebhook,
  getCurrentPlan,
} from '../controllers/billing.controller'

const router = Router()

// Auth routes
router.post('/auth/register', register)
router.post('/auth/login', login)
router.post('/auth/refresh', refresh)

// Endpoint routes
router.get('/endpoints', authenticate, listEndpoints)
router.post('/endpoints', authenticate, createEndpoint)
router.get('/endpoints/:id', authenticate, getEndpoint)
router.patch('/endpoints/:id', authenticate, updateEndpoint)
router.delete('/endpoints/:id', authenticate, deleteEndpoint)

// Destination routes
router.get('/endpoints/:id/destinations', authenticate, listDestinations)
router.post('/endpoints/:id/destinations', authenticate, createDestination)
router.delete(
  '/endpoints/:id/destinations/:dId',
  authenticate,
  deleteDestination
)

//Billing routes
router.get('/billing/plans', getPlans)
router.get('/billing/current', authenticate, getCurrentPlan)
router.post('/billing/initialize', authenticate, initializePayment)
router.post('/billing/webhook', handleWebhook)

// Event routes
router.get('/endpoints/:id/events', authenticate, listEvents)
router.get('/endpoints/:id/events/:eId', authenticate, getEvent)
router.post('/endpoints/:id/events/:eId/replay', authenticate, replayEvent)
router.get(
  '/endpoints/:id/events/:eId/deliveries',
  authenticate,
  getEventDeliveries
)

//Ai routes
router.get(
  '/endpoints/:id/events/:eId/ai/explain',
  authenticate,
  explainPayload
)
router.get('/endpoints/:id/events/:eId/ai/schema', authenticate, generateSchema)
router.post(
  '/endpoints/:id/events/:eId/ai/handler',
  authenticate,
  generateHandler
)
router.get(
  '/endpoints/:id/events/:eId/ai/diagnose',
  authenticate,
  diagnoseFailure
)

// Admin stats (protect this with your own user ID check in production)
router.get('/admin/stats', authenticate, async (req, res) => {
  const db = (await import('../db')).AppDataSource
  const [
    [{ count: total_users }],
    [{ count: free_users }],
    [{ count: pro_users }],
    [{ count: total_events }],
    [{ count: total_endpoints }],
    [{ count: events_today }],
  ] = await Promise.all([
    db.query('SELECT COUNT(*) FROM users'),
    db.query("SELECT COUNT(*) FROM users WHERE plan = 'free'"),
    db.query("SELECT COUNT(*) FROM users WHERE plan = 'pro'"),
    db.query('SELECT COUNT(*) FROM events'),
    db.query('SELECT COUNT(*) FROM endpoints'),
    db.query(
      "SELECT COUNT(*) FROM events WHERE received_at >= NOW() - INTERVAL '1 day'"
    ),
  ])

  res.json({
    total_users: parseInt(total_users),
    free_users: parseInt(free_users),
    pro_users: parseInt(pro_users),
    total_events: parseInt(total_events),
    total_endpoints: parseInt(total_endpoints),
    events_today: parseInt(events_today),
  })
})

export default router
