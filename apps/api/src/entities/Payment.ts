import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm'

/**
 * `initiated` is written by `initializePayment` before the user is redirected to the
 * provider; the other three are webhook outcomes.
 *
 * The intent row is what makes the webhook authoritative rather than trusting
 * provider metadata: it records, server-side, which user asked for which plan at what
 * price, so the webhook resolves the grant from our own row instead of from a
 * `metadata.plan` field that round-tripped through the client (H-06).
 */
export type PaymentStatus = 'initiated' | 'succeeded' | 'rejected' | 'ignored'

/**
 * Append-only ledger of every payment webhook the API accepted or rejected.
 *
 * Serves three purposes the previous code had no answer for (H-06, H-37):
 *  1. Idempotency — `(provider, provider_reference)` is unique, so a replayed
 *     webhook cannot extend a subscription twice.
 *  2. Amount authority — the charged amount is recorded next to the plan that was
 *     granted, so a mismatch is auditable rather than invisible.
 *  3. Reconciliation — rejected webhooks are recorded with a reason instead of
 *     being dropped on the floor.
 *
 * Deliberately stores a digest of the payload rather than the payload itself, so
 * provider PII and card metadata never land in our database.
 */
@Entity('payments')
@Unique('payments_provider_reference_unique', ['provider', 'provider_reference'])
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Index('idx_payments_user_id')
  @Column({ type: 'uuid', nullable: true })
  user_id!: string | null

  @Column({ type: 'varchar', length: 50 })
  provider!: string

  /** Provider's own transaction reference / id. Unique per provider. */
  @Column({ type: 'varchar', length: 255 })
  provider_reference!: string

  @Column({ type: 'varchar', length: 100 })
  event_type!: string

  /** Amount in the provider's minor unit (kobo, cents), as charged. */
  @Column({ type: 'bigint', nullable: true })
  amount_minor!: string | null

  @Column({ type: 'varchar', length: 3, nullable: true })
  currency!: string | null

  /** Plan the webhook asked to grant. Null for non-subscription events. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  plan!: string | null

  @Column({ type: 'varchar', length: 20 })
  status!: PaymentStatus

  /** Why a webhook was rejected or ignored. Never contains provider secrets. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null

  /** SHA-256 of the exact bytes we verified, for after-the-fact dispute resolution. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  payload_digest!: string | null

  @Index('idx_payments_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date
}
