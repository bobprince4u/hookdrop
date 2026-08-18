import { DataSource } from 'typeorm'
import { User } from '../entities/User'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery } from '../entities/Delivery'
import { AiInsight } from '../entities/AiInsight'
import { env, isProduction } from '../config/env'

/**
 * Worker DataSource, aligned with the API's (H-38, H-44, H-48).
 *
 * Three differences from what this was: the URL comes from validated configuration rather
 * than a `process.env` read behind a cwd-relative `dotenv.config` that usually loaded
 * nothing; TLS is enabled for managed Postgres in production, which the worker previously
 * omitted entirely; and the pool is bounded, because three services sharing one small
 * managed instance can exhaust its connection limit at the default of 10 each.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [User, Endpoint, Event, Destination, Delivery, AiInsight],
  migrations: [],
  subscribers: [],
  /**
   * Managed Postgres terminates TLS with a chain Node has no root for, while putting the
   * connection on the public internet. `rejectUnauthorized: false` keeps the transport
   * encrypted without authenticating the server — enabled only when the URL does not
   * already say `sslmode=disable`.
   */
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
    console.log('Worker: Database connected')
  } catch (error) {
    // pg puts the connection string in some failure messages; redact before logging (H-48).
    console.error(
      'Worker: Database connection failed:',
      error instanceof Error
        ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]')
        : 'unknown error'
    )
    process.exit(1)
  }
}
