import { Request, Response, NextFunction } from 'express'
import { ZodType } from 'zod'

/**
 * Turns a Zod schema into Express middleware.
 *
 * Validation failures return a 400 listing field names and messages, never the
 * submitted values — a rejected password must not be echoed back in an error
 * body that ends up in a log or an error tracker (H-48).
 */

const formatIssues = (
  error: { issues: { path: (string | number | symbol)[]; message: string }[] }
): { field: string; message: string }[] =>
  error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(body)',
    message: issue.message,
  }))

export const validateBody =
  <T>(schema: ZodType<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      res
        .status(400)
        .json({ error: 'Validation failed', details: formatIssues(result.error) })
      return
    }
    // `req.body` is a plain writable property, unlike `req.query`.
    req.body = result.data
    next()
  }

export const validateQuery =
  <T>(schema: ZodType<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      res
        .status(400)
        .json({ error: 'Validation failed', details: formatIssues(result.error) })
      return
    }
    req.validatedQuery = result.data
    next()
  }

/** Reads what `validateQuery` stored. Throws if the middleware was not mounted. */
export const validatedQuery = <T>(req: Request): T => {
  if (req.validatedQuery === undefined) {
    throw new Error('validateQuery middleware did not run for this route')
  }
  return req.validatedQuery as T
}

export const validateParams =
  <T>(schema: ZodType<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params)
    if (!result.success) {
      res
        .status(400)
        .json({ error: 'Invalid path parameter', details: formatIssues(result.error) })
      return
    }
    next()
  }
