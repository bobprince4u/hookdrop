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
import { Destination } from './Destination'

@Entity('deliveries')
@Unique(['event_id', 'destination_id'])
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  event_id!: string

  @Column({ type: 'uuid' })
  destination_id!: string

  @Column({ type: 'integer', default: 0 })
  attempt_count!: number

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: string

  @Column({ type: 'integer', nullable: true })
  response_code!: number

  @Column({ type: 'text', nullable: true })
  response_body!: string

  @Column({ type: 'timestamptz', nullable: true })
  last_attempted_at!: Date

  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @ManyToOne(() => Event, (event) => event.deliveries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'event_id' })
  event!: Event

  @ManyToOne(() => Destination, (destination) => destination.deliveries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'destination_id' })
  destination!: Destination
}
