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
   *
   * `select: false` because three handlers returned this verbatim — the destination
   * list, the create response, and `GET /endpoints/:id` through
   * `relations: ['destinations']` — so a signing key was readable from any of them,
   * and every future handler would have leaked it by default too (H-11). Excluding
   * it at the column is what makes that safe by default rather than by review.
   *
   * The one consumer that legitimately needs the key is the delivery signer in the
   * worker, which opts back in with an explicit `addSelect`. If you add another,
   * opt in the same way — do not remove this.
   */
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
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
