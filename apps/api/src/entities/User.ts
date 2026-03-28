import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
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

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date

  @OneToMany(() => Endpoint, (endpoint) => endpoint.user)
  endpoints!: Endpoint[]
}
