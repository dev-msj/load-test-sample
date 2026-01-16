import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('file_records')
export class FileRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'varchar', length: 255 })
  filename: string;

  @Column({ name: 'file_size', type: 'int' })
  fileSize: number;

  @Column({ name: 'content_hash', type: 'varchar', length: 64, nullable: true })
  contentHash: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
