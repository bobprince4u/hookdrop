import { Response } from 'express'
import { GoogleGenAI } from '@google/genai'
import { AppDataSource } from '../db'
import { Event } from '../entities/Event'
import { Delivery } from '../entities/Delivery'
import { AiInsight } from '../entities/AiInsight'
import { AuthRequest } from '../middleware/auth'
import { Endpoint } from '../entities/Endpoint'
import { User } from '../entities/User'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' })

const AI_PLANS = ['starter', 'pro', 'team']

const generate = async (prompt: string): Promise<string> => {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: prompt,
  })
  return response.text ?? ''
}

const checkAIAccess = async (userId: string): Promise<boolean> => {
  const userRepo = AppDataSource.getRepository(User)
  const user = await userRepo.findOne({ where: { id: userId } })
  return AI_PLANS.includes(user?.plan || '')
}

const getOrCreateInsight = async (
  eventId: string,
  insightType: string,
  generateFn: () => Promise<string>
): Promise<string> => {
  const insightRepo = AppDataSource.getRepository(AiInsight)

  const existing = await insightRepo.findOne({
    where: { event_id: eventId, insight_type: insightType },
  })
  if (existing) return existing.content

  const content = await generateFn()
  const insight = insightRepo.create({ event_id: eventId, insight_type: insightType, content })
  await insightRepo.save(insight)
  return content
}

export const explainPayload = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const hasAccess = await checkAIAccess(req.user!.id)
    if (!hasAccess) {
      res.status(403).json({
        error: 'AI features are available on Starter plan and above.',
        upgrade_required: true,
        upgrade_url: '/dashboard/billing',
      })
      return
    }

    const eId = req.params.eId as string
    const id = req.params.id as string

    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoint = await endpointRepo.findOne({ where: { id, user_id: req.user!.id } })
    if (!endpoint) { res.status(404).json({ error: 'Endpoint not found' }); return }

    const eventRepo = AppDataSource.getRepository(Event)
    const event = await eventRepo.findOne({ where: { id: eId, endpoint_id: id } })
    if (!event) { res.status(404).json({ error: 'Event not found' }); return }

    const content = await getOrCreateInsight(eId, 'explanation', async () => {
      return generate(`You are a webhook expert helping a developer understand an incoming webhook payload.
Explain this webhook payload in 2-3 plain English sentences. Be specific about what event occurred, what triggered it, and what the key fields mean.

Payload:
${event.body}

Headers:
${JSON.stringify(event.headers, null, 2)}`)
    })

    res.json({ explanation: content })
  } catch (error) {
    console.error('Explain error:', error)
    res.status(500).json({ error: 'AI service unavailable' })
  }
}

export const generateSchema = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const hasAccess = await checkAIAccess(req.user!.id)
    if (!hasAccess) {
      res.status(403).json({
        error: 'AI features are available on Starter plan and above.',
        upgrade_required: true,
        upgrade_url: '/dashboard/billing',
      })
      return
    }

    const eId = req.params.eId as string
    const id = req.params.id as string

    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoint = await endpointRepo.findOne({ where: { id, user_id: req.user!.id } })
    if (!endpoint) { res.status(404).json({ error: 'Endpoint not found' }); return }

    const eventRepo = AppDataSource.getRepository(Event)
    const event = await eventRepo.findOne({ where: { id: eId, endpoint_id: id } })
    if (!event) { res.status(404).json({ error: 'Event not found' }); return }

    const content = await getOrCreateInsight(eId, 'schema', async () => {
      return generate(`Generate a TypeScript interface for this webhook payload.
Only return the TypeScript code, no explanation, no markdown backticks.

Payload:
${event.body}`)
    })

    res.json({ schema: content })
  } catch (error) {
    console.error('Schema error:', error)
    res.status(500).json({ error: 'AI service unavailable' })
  }
}

export const generateHandler = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const hasAccess = await checkAIAccess(req.user!.id)
    if (!hasAccess) {
      res.status(403).json({
        error: 'AI features are available on Starter plan and above.',
        upgrade_required: true,
        upgrade_url: '/dashboard/billing',
      })
      return
    }

    const eId = req.params.eId as string
    const id = req.params.id as string
    const { language = 'typescript', framework = 'express' } = req.body

    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoint = await endpointRepo.findOne({ where: { id, user_id: req.user!.id } })
    if (!endpoint) { res.status(404).json({ error: 'Endpoint not found' }); return }

    const eventRepo = AppDataSource.getRepository(Event)
    const event = await eventRepo.findOne({ where: { id: eId, endpoint_id: id } })
    if (!event) { res.status(404).json({ error: 'Event not found' }); return }

    const cacheKey = `handler_${language}_${framework}`

    const content = await getOrCreateInsight(eId, cacheKey, async () => {
      return generate(`Write a complete ${language} webhook handler for ${framework} that processes this payload.
Include HMAC signature verification, proper error handling, and meaningful business logic based on the event type.
Only return the code, no explanation, no markdown backticks.

Payload:
${event.body}

Headers received:
${JSON.stringify(event.headers, null, 2)}`)
    })

    res.json({ handler: content })
  } catch (error) {
    console.error('Handler error:', error)
    res.status(500).json({ error: 'AI service unavailable' })
  }
}

export const diagnoseFailure = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const hasAccess = await checkAIAccess(req.user!.id)
    if (!hasAccess) {
      res.status(403).json({
        error: 'AI features are available on Starter plan and above.',
        upgrade_required: true,
        upgrade_url: '/dashboard/billing',
      })
      return
    }

    const eId = req.params.eId as string
    const id = req.params.id as string

    const endpointRepo = AppDataSource.getRepository(Endpoint)
    const endpoint = await endpointRepo.findOne({ where: { id, user_id: req.user!.id } })
    if (!endpoint) { res.status(404).json({ error: 'Endpoint not found' }); return }

    const eventRepo = AppDataSource.getRepository(Event)
    const deliveryRepo = AppDataSource.getRepository(Delivery)

    const event = await eventRepo.findOne({ where: { id: eId, endpoint_id: id } })
    if (!event) { res.status(404).json({ error: 'Event not found' }); return }

    const deliveries = await deliveryRepo.find({
      where: { event_id: eId },
      order: { created_at: 'DESC' },
    })

    const content = await getOrCreateInsight(eId, 'failure_diagnosis', async () => {
      const failedDeliveries = deliveries.filter(d => d.status !== 'delivered')
      return generate(`You are a webhook debugging expert. A webhook delivery failed.
Explain in plain English:
1. What likely caused the failure
2. How to fix it
3. What to check in the receiving server

Webhook payload:
${event.body}

Failed delivery attempts:
${JSON.stringify(failedDeliveries.map(d => ({
  attempt: d.attempt_count,
  status: d.status,
  response_code: d.response_code,
  response_body: d.response_body,
  attempted_at: d.last_attempted_at,
})), null, 2)}

Be specific and actionable. Keep it under 5 sentences.`)
    })

    res.json({ diagnosis: content })
  } catch (error) {
    console.error('Diagnose error:', error)
    res.status(500).json({ error: 'AI service unavailable' })
  }
}
