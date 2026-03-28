import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    plan: string
  }
}

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'fallback_secret'
    ) as { id: string; email: string; plan: string }

    req.user = decoded
    next()
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}
