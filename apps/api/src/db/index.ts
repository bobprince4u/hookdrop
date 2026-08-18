import { DataSource } from 'typeorm'
import { User } from '../entities/User'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery } from '../entities/Delivery'
import { AiInsight } from '../entities/AiInsight'
import { RefreshToken } from '../entities/RefreshToken'
import { Payment } from '../entities/Payment'
import { env, isProduction } from '../config/env'

/**
 * `synchronize` stays false: schema changes go through node-pg-migrate so they are
 * reviewable and reversible. Leaving it false also means the two new entities below
 * require their migration to have run — see `migrations/`.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [
    User,
    Endpoint,
    Event,
    Destination,
    Delivery,
    AiInsight,
    RefreshToken,
    Payment,
  ],
  migrations: [],
  subscribers: [],
  /**
   * Managed Postgres (Neon, Railway, Supabase) terminates TLS with a certificate
   * chain Node does not ship a root for, and every one of those providers puts the
   * connection on the public internet. `rejectUnauthorized: false` keeps the
   * transport encrypted; it does not authenticate the server, which is why it is
   * only enabled when the URL does not already say `sslmode=disable`.
   */
  ssl:
    isProduction && !/sslmode=disable/.test(env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
  // Bounded pool: the default is 10 per process, and three processes plus a
  // serverless platform's concurrency can exhaust a small managed instance.
  extra: {
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  },
})

export const initDB = async (): Promise<void> => {
  try {
    await AppDataSource.initialize()
    console.log('API: Database connected')
  } catch (error) {
    // The message can contain the connection string; log only the error name.
    console.error(
      'API: Database connection failed:',
      error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]') : 'unknown error'
    )
    process.exit(1)
  }
}
