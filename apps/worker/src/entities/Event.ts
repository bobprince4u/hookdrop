import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm'
import { Endpoint } from './Endpoint'
import { Delivery } from './Delivery'
import { AiInsight } from './AiInsight'

export type EventStatus =
  | 'received'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'dead_letter'

// The dashboard's default query is "this endpoint's events, newest first", and the
// retention job deletes by age. Both need this composite index (H-37).
@Index('idx_events_endpoint_received', ['endpoint_id', 'received_at'])
@Entity('events')
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  endpoint_id!: string

  @Column({ type: 'varchar', length: 10, default: 'POST' })
  method!: string

  @Column({ type: 'jsonb', default: {} })
  headers!: Record<string, unknown>

  @Column({ type: 'text', nullable: true })
  body!: string | null

  @Column({ type: 'varchar', length: 45, nullable: true })
  source_ip!: string | null

  @Column({ type: 'varchar', length: 20, default: 'received' })
  status!: EventStatus

  @CreateDateColumn({ type: 'timestamptz' })
  received_at!: Date

  @ManyToOne(() => Endpoint, (endpoint) => endpoint.events, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'endpoint_id' })
  endpoint!: Endpoint

  @OneToMany(() => Delivery, (delivery) => delivery.event)
  deliveries!: Delivery[]

  @OneToMany(() => AiInsight, (insight) => insight.event)
  ai_insights!: AiInsight[]
}
