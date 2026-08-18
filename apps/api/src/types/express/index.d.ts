import type { Request } from 'express'

declare global {
  namespace Express {
    interface Request {
      /**
       * Exact bytes of the request body, captured only on routes that mount
       * `express.raw`. Payment webhook signatures are computed over these bytes;
       * re-serialising parsed JSON produces a different byte string and therefore
       * a different HMAC (H-05).
       */
      rawBody?: Buffer
      /**
       * Output of the query-validation middleware. `req.query` itself is a getter
       * in Express 5 and cannot be safely reassigned, so validated values live here.
       */
      validatedQuery?: unknown
    }
  }
}

export type { Request }
