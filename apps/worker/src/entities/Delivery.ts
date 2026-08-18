import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm'
import { Event } from './Event'
import { Destination } from './Destination'

/**
 * Terminal states: `delivered` and `dead_letter`. `pending` and `retrying` are
 * in-flight. The processor is the only writer and moves strictly forward, except
 * for an explicit replay which resets to `pending` (H-02, H-08).
 */
export type DeliveryStatus =
  | 'pending'
  | 'retrying'
  | 'delivered'
  | 'failed'
  | 'dead_letter'

@Entity('deliveries')
@Unique(['event_id', 'destination_id'])
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Index('idx_deliveries_event_id')
  @Column({ type: 'uuid' })
  event_id!: string

  @Column({ type: 'uuid' })
  destination_id!: string

  @Column({ type: 'integer', default: 0 })
  attempt_count!: number

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: DeliveryStatus

  // Nullable columns are typed nullable. Declaring them `!: number` made every
  // read look safe under `strict` when the value can genuinely be null (H-36).
  @Column({ type: 'integer', nullable: true })
  response_code!: number | null

  @Column({ type: 'text', nullable: true })
  response_body!: string | null

  @Column({ type: 'timestamptz', nullable: true })
  last_attempted_at!: Date | null

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @ManyToOne(() => Event, (event) => event.deliveries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event

  @ManyToOne(() => Destination, (destination) => destination.deliveries, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'destination_id' })
  destination!: Destination
}
