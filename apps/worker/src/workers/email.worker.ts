import { Worker } from 'bullmq'
import { redis } from '../queue'
import { sendDay1TipsEmail, sendDay3UpgradeEmail } from '../services/email.service'

export const startEmailWorker = () => {
  const worker = new Worker(
    'email',
    async (job) => {
      const { email, name } = job.data

      if (job.name === 'day1-tips') {
        await sendDay1TipsEmail(email, name)
        console.log(`Day 1 tips sent to ${email}`)
      }

      if (job.name === 'day3-upgrade') {
        await sendDay3UpgradeEmail(email, name)
        console.log(`Day 3 upgrade email sent to ${email}`)
      }
    },
    {
      connection: redis,
      stalledInterval: 60000,    // check stalled jobs every 60s instead of default 5s
      maxStalledCount: 2,
    }
  )

  worker.on('failed', (job, err) => {
    console.error(`Email job ${job?.id} failed:`, err)
  })

  console.log('Email worker started')
}
