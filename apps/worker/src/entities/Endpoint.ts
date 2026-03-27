import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm'
import { User } from './User'
import { Event } from './Event'
import { Destination } from './Destination'

@Entity('endpoints')
export class Endpoint {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'uuid' })
  user_id!: string

  @Column({ type: 'varchar', length: 255 })
  name!: string

  @Column({ type: 'varchar', length: 100, unique: true })
  public_token!: string

  @Column({ type: 'boolean', default: true })
  is_active!: boolean

  @Column({ type: 'jsonb', default: {} })
  metadata!: object

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @ManyToOne(() => User, (user) => user.endpoints, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User

  @OneToMany(() => Event, (event) => event.endpoint)
  events!: Event[]

  @OneToMany(() => Destination, (destination) => destination.endpoint)
  destinations!: Destination[]
}
