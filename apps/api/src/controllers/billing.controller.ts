import { Request, Response } from 'express'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { AuthRequest } from '../middleware/auth'
import crypto from 'crypto'
import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || ''

const PLANS = {
  starter: { name: 'Starter', amount: 7500, events: 10000, retention_hours: 168 },
  free: { name: 'Free', amount: 0, events: 500, retention_hours: 24 },
  pro: { name: 'Pro', amount: 19000, events: 100000, retention_hours: 720 },
  team: { name: 'Team', amount: 49000, events: 500000, retention_hours: 2160 },
}

export const getPlans = async (_req: Request, res: Response): Promise<void> => {
  res.json({ plans: PLANS })
}

export const initializePayment = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { plan } = req.body

    if (!plan || !PLANS[plan as keyof typeof PLANS]) {
      res.status(400).json({ error: 'Invalid plan' })
      return
    }

    if (plan === 'free') {
      res.status(400).json({ error: 'Cannot pay for free plan' })
      return
    }

    const selectedPlan = PLANS[plan as keyof typeof PLANS]

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: req.user!.email,
        amount: selectedPlan.amount * 100, // Paystack uses kobo
        currency: 'NGN',
        metadata: {
          user_id: req.user!.id,
          plan,
        },
        callback_url: `${process.env.FRONTEND_URL}/dashboard/billing/success`,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json',
        },
      }
    )

    res.json({
      authorization_url: response.data.data.authorization_url,
      reference: response.data.data.reference,
    })
  } catch (error) {
    console.error('Payment init error:', error)
    res.status(500).json({ error: 'Payment initialization failed' })
  }
}

export const handleWebhook = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    // Verify webhook signature
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex')

    if (hash !== req.headers['x-paystack-signature']) {
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    const event = req.body

    if (event.event === 'charge.success') {
      const { user_id, plan } = event.data.metadata

      if (user_id && plan) {
        const userRepo = AppDataSource.getRepository(User)
        await userRepo.update(user_id, { plan })
        console.log(`User ${user_id} upgraded to ${plan}`)
      }
    }

    if (event.event === 'subscription.disable') {
      const { user_id } = event.data.metadata
      if (user_id) {
        const userRepo = AppDataSource.getRepository(User)
        await userRepo.update(user_id, { plan: 'free' })
        console.log(`User ${user_id} downgraded to free`)
      }
    }

    res.status(200).json({ ok: true })
  } catch (error) {
    console.error('Webhook error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

export const getCurrentPlan = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ where: { id: req.user!.id } })

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const plan = PLANS[user.plan as keyof typeof PLANS] || PLANS.free

    res.json({
      current_plan: user.plan,
      limits: plan,
    })
  } catch (error) {
    console.error('Get plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
