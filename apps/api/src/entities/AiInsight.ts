import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm'
import { Event } from './Event'

@Entity('ai_insights')
@Unique(['event_id', 'insight_type'])
export class AiInsight {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  event_id!: string

  @Column({ type: 'varchar', length: 50 })
  insight_type!: string

  @Column({ type: 'text' })
  content!: string

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @ManyToOne(() => Event, (event) => event.ai_insights, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event
}
