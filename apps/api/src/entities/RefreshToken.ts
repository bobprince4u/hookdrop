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
 * Server-side record of issued refresh tokens.
 *
 * Refresh tokens are opaque random values, not JWTs, so they can be revoked.
 * Only an HMAC of the token is stored: a read-only database leak does not let an
 * attacker mint sessions (H-16).
 */
@Entity('refresh_tokens')
export class RefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Index('idx_refresh_tokens_user_id')
  @Column({ type: 'uuid' })
  user_id!: string

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User

  /** HMAC-SHA256(token, REFRESH_TOKEN_SECRET), hex encoded. Never the raw token. */
  @Index('idx_refresh_tokens_token_hash', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  token_hash!: string

  /** Indexed because `purgeExpiredRefreshTokens` deletes by this column. */
  @Index('idx_refresh_tokens_expires_at')
  @Column({ type: 'timestamptz' })
  expires_at!: Date

  @Column({ type: 'timestamptz', nullable: true })
  revoked_at!: Date | null

  /** Set when this token was consumed by a rotation, pointing at its successor. */
  @Column({ type: 'uuid', nullable: true })
  replaced_by_id!: string | null

  @Column({ type: 'varchar', length: 255, nullable: true })
  user_agent!: string | null

  @Column({ type: 'varchar', length: 45, nullable: true })
  created_ip!: string | null

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date
}
