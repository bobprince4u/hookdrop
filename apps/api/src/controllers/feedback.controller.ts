import { Response } from 'express'
import { AuthRequest } from '../middleware/auth'
import { sendFeedbackEmail } from '../services/email.service'
import type { z } from 'zod'
import type { feedbackSchema } from '../validation/schemas'

/**
 * In-app feedback relay (H-23).
 *
 * The inline handler this replaces had three defects in five lines:
 *
 *  - It called `sendFeedbackEmail(req.user!.email, req.user!.id, type, message)`,
 *    putting a uuid in the `userName` position, so every feedback email was subject-
 *    lined with an id.
 *  - It validated nothing. `type` was free text interpolated into a mail subject and
 *    `message` was unbounded.
 *  - It returned `{ ok: true }` unconditionally, discarding the boolean the service
 *    returns — so when no admin recipient was configured, the user was told their
 *    feedback had been sent and it had not been.
 */

type FeedbackInput = z.infer<typeof feedbackSchema>

export const submitFeedback = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    // `type` is a closed enum and `message` is capped at 5 000 characters by
    // `feedbackSchema`, mounted on this route.
    const { type, message } = req.body as FeedbackInput

    /**
     * The display name comes from the loaded user row. Access-token claims carry only
     * id, email and plan, which is why the original call had nothing better than an id
     * to pass — the fix is to load the row, not to relabel the argument.
     */
    const name = req.currentUser?.name?.trim() || req.user!.email

    const sent = await sendFeedbackEmail(req.user!.email, name, type, message)

    if (!sent) {
      /**
       * 503, not 500: nothing failed, the instance simply has nowhere to route
       * feedback. Reporting it honestly means the user can use another channel
       * instead of assuming a human will read this.
       */
      res.status(503).json({
        error: 'Feedback cannot be delivered right now. Please email us directly.',
        code: 'feedback_unavailable',
      })
      return
    }

    res.json({ ok: true })
  } catch (error) {
    console.error('Feedback error:', error)
    res.status(500).json({ error: 'Failed to send feedback' })
  }
}
