import { Request, Response, NextFunction } from 'express'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Endpoint } from '../entities/Endpoint'

const PLAN_LIMITS = {
  starter: { events_per_month: 10000, retention_hours: 168 },
  free: { events_per_month: 500, retention_hours: 24 },
  pro: { events_per_month: 100000, retention_hours: 720 },
  team: { events_per_month: 500000, retention_hours: 2160 },
}

export const checkPlanLimits = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = req.params.token as string

    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoint = await endpointRepo.findOne({
      where: { public_token: token, is_active: true },
      relations: ['user'],
    })

    if (!endpoint) {
      next()
      return
    }

    const userPlan = endpoint.user?.plan || 'free'
    const limits = PLAN_LIMITS[userPlan as keyof typeof PLAN_LIMITS] || PLAN_LIMITS.free

    // Count events this month
    const eventRepo = AppDataSource.getRepository(Event)
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const eventCount = await eventRepo
      .createQueryBuilder('event')
      .innerJoin('event.endpoint', 'ep')
      .where('ep.user_id = :userId', { userId: endpoint.user_id })
      .andWhere('event.received_at >= :startOfMonth', { startOfMonth })
      .getCount()

    if (eventCount >= limits.events_per_month) {
      res.status(429).json({
        error: 'Monthly event limit reached',
        limit: limits.events_per_month,
        current: eventCount,
        plan: userPlan,
        upgrade_url: `${process.env.FRONTEND_URL}/dashboard/settings`,
      })
      return
    }

    next()
  } catch (error) {
    console.error('Plan limit check error:', error)
    next()
  }
}
