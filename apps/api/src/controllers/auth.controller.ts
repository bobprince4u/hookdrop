import { Request, Response } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { AppDataSource } from '../db'
import { User } from '../entities/User'
import dotenv from 'dotenv'

dotenv.config({ path: '../../.env' })

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m'
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET || 'fallback_refresh'
const REFRESH_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || '30d'

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, name, password } = req.body

    if (!email || !name || !password) {
      res.status(400).json({ error: 'Email, name and password are required' })
      return
    }

    const userRepo = AppDataSource.getRepository(User)

    // Check if user already exists
    const existing = await userRepo.findOne({ where: { email } })
    if (existing) {
      res.status(409).json({ error: 'Email already registered' })
      return
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10)

    // Create user
    const user = userRepo.create({ email, name, password_hash, plan: 'free' })
    const savedUser = await userRepo.save(user)

    // Generate tokens
    const accessToken = jwt.sign(
      { id: savedUser.id, email: savedUser.email, plan: savedUser.plan },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
    )

    const refreshToken = jwt.sign(
      { id: savedUser.id },
      REFRESH_SECRET,
      { expiresIn: REFRESH_EXPIRES_IN } as jwt.SignOptions
    )

    res.status(201).json({
      user: {
        id: savedUser.id,
        email: savedUser.email,
        name: savedUser.name,
        plan: savedUser.plan,
      },
      accessToken,
      refreshToken,
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' })
      return
    }

    const userRepo = AppDataSource.getRepository(User)

    const user = await userRepo.findOne({ where: { email } })
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, plan: user.plan },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
    )

    const refreshToken = jwt.sign(
      { id: user.id },
      REFRESH_SECRET,
      { expiresIn: REFRESH_EXPIRES_IN } as jwt.SignOptions
    )

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
      },
      accessToken,
      refreshToken,
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}

export const refresh = async (req: Request, res: Response): Promise<void> => {
  try {
    const { refreshToken } = req.body

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token required' })
      return
    }

    const decoded = jwt.verify(refreshToken, REFRESH_SECRET) as { id: string }

    const userRepo = AppDataSource.getRepository(User)
    const user = await userRepo.findOne({ where: { id: decoded.id } })

    if (!user) {
      res.status(401).json({ error: 'User not found' })
      return
    }

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, plan: user.plan },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions
    )

    res.json({ accessToken })
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token' })
  }
}
