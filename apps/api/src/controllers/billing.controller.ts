import { Request, Response } from 'express'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { AuthRequest } from '../middleware/auth'
import { defaultProvider, getProvider } from '../services/payments'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

export const PLANS: Record<
  string,
  {
    name: string
    amount: number
    currency: string
    events: number
    retention_hours: number
  }
> = {
  free: {
    name: 'Free',
    amount: 0,
    currency: 'NGN',
    events: 500,
    retention_hours: 24,
  },
  starter: {
    name: 'Starter',
    amount: 7500,
    currency: 'NGN',
    events: 10000,
    retention_hours: 168,
  },
  pro: {
    name: 'Pro',
    amount: 19000,
    currency: 'NGN',
    events: 100000,
    retention_hours: 720,
  },
  team: {
    name: 'Team',
    amount: 49000,
    currency: 'NGN',
    events: 500000,
    retention_hours: 2160,
  },
}

export const getPlans = async (_req: Request, res: Response): Promise<void> => {
  res.json({ plans: PLANS })
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

    const plan = PLANS[user.plan] || PLANS.free

    res.json({
      current_plan: user.plan,
      payment_provider: user.payment_provider,
      limits: plan,
      plan_expires_at: user.plan_expires_at,
    })
  } catch (error) {
    console.error('Get plan error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const initializePayment = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { plan, provider: providerName } = req.body

    if (!plan || !PLANS[plan]) {
      res.status(400).json({ error: 'Invalid plan' })
      return
    }

    if (plan === 'free') {
      res.status(400).json({ error: 'Cannot pay for free plan' })
      return
    }

    const selectedPlan = PLANS[plan]

    // Use specified provider or default
    const provider = providerName
      ? getProvider(providerName)
      : defaultProvider()

    const result = await provider.initializePayment(
      req.user!.email,
      selectedPlan.amount,
      selectedPlan.currency,
      {
        user_id: req.user!.id,
        plan,
        provider: provider.name,
      },
      `${process.env.FRONTEND_URL}/dashboard/billing/success`
    )

    res.json(result)
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
    // Detect provider from header
    const paystackSig = req.headers['x-paystack-signature'] as string
    const stripeSig = req.headers['stripe-signature'] as string
    const flutterwaveSig = req.headers['verif-hash'] as string

    let providerName = 'paystack'
    let signature = paystackSig

    if (stripeSig) {
      providerName = 'stripe'
      signature = stripeSig
    } else if (flutterwaveSig) {
      providerName = 'flutterwave'
      signature = flutterwaveSig
    }

    const provider = getProvider(providerName)
    const payload = JSON.stringify(req.body)

    const result = provider.verifyWebhook(payload, signature)

    if (!result.valid) {
      res.status(401).json({ error: 'Invalid webhook signature' })
      return
    }

    const userRepo = AppDataSource.getRepository(User)

    if (
      result.event === 'charge.success' ||
      result.event === 'payment_intent.succeeded' ||
      result.event === 'checkout.session.completed' ||
      result.event === 'invoice.paid'
    ) {
      const metadata = (result.data.metadata || result.data) as Record<
        string,
        unknown
      >
      const userId = metadata.user_id as string
      const plan = metadata.plan as string

      if (userId && plan) {
        await userRepo.update(userId, {
          plan,
          payment_provider: providerName,
          payment_customer_id: provider.getCustomerId(result.data),
          payment_subscription_id: provider.getSubscriptionId(result.data),
          plan_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        })
        console.log(`User ${userId} upgraded to ${plan} via ${providerName}`)
      }
    }

    if (
      result.event === 'subscription.disable' ||
      result.event === 'customer.subscription.deleted'
    ) {
      const metadata = (result.data.metadata || result.data) as Record<
        string,
        unknown
      >
      const userId = metadata.user_id as string
      if (userId) {
        await userRepo.update(userId, {
          plan: 'free',
          plan_expires_at: undefined,
        })
        console.log(`User ${userId} downgraded to free via ${providerName}`)
      }
    }

    res.status(200).json({ ok: true })
  } catch (error) {
    console.error('Webhook handler error:', error)
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}
