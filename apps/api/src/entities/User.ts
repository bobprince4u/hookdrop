import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
} from 'typeorm'
import { Endpoint } from './Endpoint'

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string

  @Column({ type: 'varchar', length: 255 })
  name!: string

  @Column({ type: 'varchar', length: 255 })
  password_hash!: string

  @Column({ type: 'varchar', length: 50, default: 'free' })
  plan!: string

  @Column({ type: 'varchar', length: 50, nullable: true })
  payment_provider!: string | null

  @Column({ type: 'varchar', length: 255, nullable: true })
  payment_customer_id!: string | null

  @Column({ type: 'varchar', length: 255, nullable: true })
  payment_subscription_id!: string | null

  /**
   * When the current paid plan lapses.
   *
   * Null on a paid plan is treated as expired, not perpetual — see
   * `resolveEffectivePlan`. Indexed because the expiry scheduler scans it (H-37).
   */
  @Index('idx_users_plan_expires_at')
  @Column({ type: 'timestamptz', nullable: true })
  plan_expires_at!: Date | null

  /**
   * Last time a plan-expiry reminder was emailed. Prevents the scheduler from
   * re-sending the same reminder on every run (H-10).
   */
  @Column({ type: 'timestamptz', nullable: true })
  last_reminder_sent_at!: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @OneToMany(() => Endpoint, (endpoint) => endpoint.user)
  endpoints!: Endpoint[]
}
