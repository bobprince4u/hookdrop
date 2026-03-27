import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm'
import { Endpoint } from './Endpoint'
import { Delivery } from './Delivery'
import { AiInsight } from './AiInsight'

@Entity('events')
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  endpoint_id!: string

  @Column({ type: 'varchar', length: 10, default: 'POST' })
  method!: string

  @Column({ type: 'jsonb', default: {} })
  headers!: object

  @Column({ type: 'text', nullable: true })
  body!: string

  @Column({ type: 'varchar', length: 45, nullable: true })
  source_ip!: string

  @Column({ type: 'varchar', length: 20, default: 'received' })
  status!: string

  @CreateDateColumn({ type: 'timestamptz' })
  received_at!: Date

  @ManyToOne(() => Endpoint, (endpoint) => endpoint.events, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'endpoint_id' })
  endpoint!: Endpoint

  @OneToMany(() => Delivery, (delivery) => delivery.event)
  deliveries!: Delivery[]

  @OneToMany(() => AiInsight, (insight) => insight.event)
  ai_insights!: AiInsight[]
}
