import { DataSource } from 'typeorm'
import { User } from '../entities/User'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery } from '../entities/Delivery'
import { AiInsight } from '../entities/AiInsight'
import { env, isProduction } from '../config/env'

/**
 * Ingestion DataSource, aligned with the API's (H-38, H-44, H-48).
 *
 * The URL now comes from validated configuration rather than a `process.env` read behind a
 * cwd-relative `dotenv.config`; TLS is enabled for managed Postgres in production, which
 * was omitted here; and the pool is bounded, since this is the highest-volume of the three
 * services and the default of 10 per process can exhaust a small managed instance.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: env.NODE_ENV === 'development',
  entities: [User, Endpoint, Event, Destination, Delivery, AiInsight],
  migrations: [],
  subscribers: [],
  ssl:
    isProduction && !/sslmode=disable/.test(env.DATABASE_URL)
      ? { rejectUnauthorized: false }
      : false,
  extra: {
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  },
})

export const initDB = async (): Promise<void> => {
  try {
    await AppDataSource.initialize()
    console.log('Ingestion: Database connected')
  } catch (error) {
    // pg puts the connection string in some failure messages; redact before logging (H-48).
    console.error(
      'Ingestion: Database connection failed:',
      error instanceof Error
        ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]')
        : 'unknown error'
    )
    process.exit(1)
  }
}
