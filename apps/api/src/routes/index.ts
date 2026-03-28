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
router.delete('/endpoints/:id/destinations/:dId', authenticate, deleteDestination)

// Event routes
router.get('/endpoints/:id/events', authenticate, listEvents)
router.get('/endpoints/:id/events/:eId', authenticate, getEvent)
router.post('/endpoints/:id/events/:eId/replay', authenticate, replayEvent)
router.get('/endpoints/:id/events/:eId/deliveries', authenticate, getEventDeliveries)

export default router
