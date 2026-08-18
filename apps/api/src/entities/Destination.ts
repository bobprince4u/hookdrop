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

@Entity('destinations')
export class Destination {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  endpoint_id!: string

  @Column({ type: 'varchar', length: 2048 })
  url!: string

  /**
   * HMAC-SHA256 signing key for outbound deliveries. Nullable: destinations
   * created before signing existed have none, and unsigned delivery stays
   * supported for them.
   */
  @Column({ type: 'varchar', length: 255, nullable: true })
  secret!: string | null

  @Column({ type: 'boolean', default: true })
  is_active!: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @ManyToOne(() => Endpoint, (endpoint) => endpoint.destinations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'endpoint_id' })
  endpoint!: Endpoint

  @OneToMany(() => Delivery, (delivery) => delivery.destination)
  deliveries!: Delivery[]
}
