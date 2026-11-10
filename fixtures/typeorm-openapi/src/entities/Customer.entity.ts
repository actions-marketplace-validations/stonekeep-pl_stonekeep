// Fixture: TypeORM entity. Not compiled; parsed as text by Stonekeep.
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'customers' })
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320, name: 'email_address' })
  contactEmail!: string;

  // @Column() commentedOut: string;

  @Column({ nullable: true, comment: 'E.164 (international) format' })
  telephone?: string;

  @Column('varchar', { name: 'passport_no', nullable: true })
  travelDocument?: string;

  @Column({ default: false })
  marketingOptIn!: boolean;

  @Column()
  iban!: string;

  @Column()
  plan!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
