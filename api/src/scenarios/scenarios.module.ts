import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';
import {
  User,
  Product,
  Order,
  OrderItem,
  FileRecord,
} from '../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Product, Order, OrderItem, FileRecord]),
  ],
  controllers: [ScenariosController],
  providers: [ScenariosService],
  exports: [ScenariosService],
})
export class ScenariosModule {}
