import cron from 'node-cron'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import { LessThan, MoreThan } from 'typeorm'
import { sendSubscriptionReminderEmail, sendExpiredEmail } from '../services/email.service'

export const startSubscriptionScheduler = () => {
  // Run every day at 9am
  cron.schedule('0 9 * * *', async () => {
    console.log('Running subscription expiry check...')
    await checkExpiringSubscriptions()
  })

  console.log('Subscription scheduler started')
}

const checkExpiringSubscriptions = async () => {
  try {
    const userRepo = AppDataSource.getRepository(User)
    const now = new Date()

    // 7 days reminder
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const sevenDaysStart = new Date(sevenDaysFromNow)
    sevenDaysStart.setHours(0, 0, 0, 0)
    const sevenDaysEnd = new Date(sevenDaysFromNow)
    sevenDaysEnd.setHours(23, 59, 59, 999)

    const expiringIn7Days = await userRepo.find({
      where: {
        plan_expires_at: MoreThan(sevenDaysStart) && LessThan(sevenDaysEnd),
      },
    })

    for (const user of expiringIn7Days) {
      await sendSubscriptionReminderEmail(user.email, user.name, user.plan, 7, user.plan_expires_at)
      console.log(`7-day reminder sent to ${user.email}`)
    }

    // 3 days reminder
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)
    const threeDaysStart = new Date(threeDaysFromNow)
    threeDaysStart.setHours(0, 0, 0, 0)
    const threeDaysEnd = new Date(threeDaysFromNow)
    threeDaysEnd.setHours(23, 59, 59, 999)

    const expiringIn3Days = await userRepo.find({
      where: {
        plan_expires_at: MoreThan(threeDaysStart) && LessThan(threeDaysEnd),
      },
    })

    for (const user of expiringIn3Days) {
      await sendSubscriptionReminderEmail(user.email, user.name, user.plan, 3, user.plan_expires_at)
      console.log(`3-day reminder sent to ${user.email}`)
    }

    // Expired today — downgrade to free
    const expiredUsers = await userRepo.find({
      where: {
        plan_expires_at: LessThan(now),
      },
    })

    for (const user of expiredUsers) {
      if (user.plan !== 'free') {
        await userRepo.update(user.id, { plan: 'free', plan_expires_at: undefined })
        await sendExpiredEmail(user.email, user.name, user.plan)
        console.log(`${user.email} downgraded to free — plan expired`)
      }
    }

  } catch (error) {
    console.error('Subscription scheduler error:', error)
  }
}
