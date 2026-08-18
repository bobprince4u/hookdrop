import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm'
import { User } from './User'

/**
 * A long-lived programmatic credential (H-27).
 *
 * Accepted alongside the bearer access token rather than replacing it, so nothing breaks
 * mid-migration: `authenticate` recognises both shapes and populates the same `req.user`.
 *
 * The raw key is never stored — only `HMAC-SHA256(key, pepper)`, hex, exactly as
 * `refresh_tokens` stores its tokens. `prefix` is the only part of the key that survives
 * server-side, and it is public by design.
 */
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Index('idx_api_keys_user_active')
  @Column({ type: 'uuid' })
  user_id!: string

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User

  /** User-supplied label, so a key can be identified before it is revoked. */
  @Column({ type: 'varchar', length: 100 })
  name!: string

  /** First characters of the key, for display. Not a secret and not sufficient to authenticate. */
  @Column({ type: 'varchar', length: 24 })
  prefix!: string

  /**
   * `select: false` so no handler can serialise it by accident — the same protection the
   * destination `secret` column needed after three endpoints leaked it (H-11). Verification
   * matches on this column in a `where` clause, which does not require selecting it.
   */
  @Index('idx_api_keys_key_hash', { unique: true })
  @Column({ type: 'varchar', length: 64, select: false })
  key_hash!: string

  /** Touched at most once every few minutes, not on every request. */
  @Column({ type: 'timestamptz', nullable: true })
  last_used_at!: Date | null

  /** `null` means the key does not expire on its own. */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null

  /** Set once, never cleared: revocation is not reversible. */
  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date
}
