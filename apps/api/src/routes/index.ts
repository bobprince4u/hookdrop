import { Router } from 'express'
import { authenticate, AuthRequest } from '../middleware/auth'
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

router.get('/billing/mode', (_req, res) => {
  res.json({
    mode: process.env.PAYMENT_MODE || 'test',
    message:
      process.env.PAYMENT_MODE === 'live'
        ? 'Payments are live'
        : 'Payments are currently in test mode. Early access Pro plan is free — contact us.',
  })
})

// Admin — manually upgrade a user (protect with your own check)
router.post(
  '/admin/upgrade-user',
  authenticate,
  async (req: AuthRequest, res) => {
    try {
      const { email, plan } = req.body
      const db = (await import('../db')).AppDataSource
      const userRepo = db.getRepository((await import('../entities/User')).User)

      const adminEmail = process.env.ADMIN_EMAIL
      if (req.user!.email !== adminEmail) {
        res.status(403).json({ error: 'Not authorized' })
        return
      }

      const user = await userRepo.findOne({ where: { email } })
      if (!user) {
        res.status(404).json({ error: 'User not found' })
        return
      }

      await userRepo.update(user.id, {
        plan,
        payment_provider: 'manual',
        plan_expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      })

      res.json({ ok: true, message: `${email} upgraded to ${plan}` })
    } catch (error) {
      console.error(error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

router.get('/test-sentry', (_req, _res) => {
  throw new Error('Sentry test error from Hookdrop API')
})

// Exchange rates via Flutterwave
router.get('/billing/rates', async (_req, res) => {
  try {
    const axios = (await import('axios')).default
    const currencies = ['USD', 'EUR', 'GBP']
    const rates: Record<string, number> = { NGN: 1 }

    await Promise.all(
      currencies.map(async (currency) => {
        try {
          const response = await axios.get(
            `https://api.flutterwave.com/v3/fx-rates?from=${currency}&to=NGN&amount=1`,
            {
              headers: {
                Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
              },
            }
          )
          rates[currency] = response.data.data.rate
        } catch {
          // Fallback rates if API fails
          const fallback: Record<string, number> = {
            USD: 1600,
            EUR: 1750,
            GBP: 2050,
          }
          rates[currency] = fallback[currency]
        }
      })
    )

    res.json({ rates, base: 'NGN' })
  } catch (error) {
    console.error('Exchange rate error:', error)
    res.json({
      rates: { NGN: 1, USD: 1600, EUR: 1750, GBP: 2050 },
      base: 'NGN',
    })
  }
})

router.post('/feedback', authenticate, async (req: AuthRequest, res) => {
  try {
    const { type, message } = req.body
    const { sendFeedbackEmail } = await import('../services/email.service')
    await sendFeedbackEmail(req.user!.email, req.user!.id, type, message)
    res.json({ ok: true })
  } catch (error) {
    console.error('Feedback error:', error)
    res.status(500).json({ error: 'Failed to send feedback' })
  }
})
