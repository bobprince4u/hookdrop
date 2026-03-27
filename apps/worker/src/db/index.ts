import { DataSource } from 'typeorm'
import dotenv from 'dotenv'
import { User } from '../entities/User'
import { Endpoint } from '../entities/Endpoint'
import { Event } from '../entities/Event'
import { Destination } from '../entities/Destination'
import { Delivery } from '../entities/Delivery'
import { AiInsight } from '../entities/AiInsight'

dotenv.config({ path: '../../.env' })

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  synchronize: false,
  logging: false,
  entities: [User, Endpoint, Event, Destination, Delivery, AiInsight],
  migrations: [],
  subscribers: [],
})

export const initDB = async (): Promise<void> => {
  try {
    await AppDataSource.initialize()
    console.log('Worker: Database connected')
  } catch (error) {
    console.error('Worker: Database connection failed:', error)
    process.exit(1)
  }
}
