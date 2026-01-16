import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScenariosModule } from './scenarios/scenarios.module';
import { MetricsModule } from './metrics/metrics.module';
import { HealthModule } from './health/health.module';
import databaseConfig from './config/database.config';
import appConfig from './config/app.config';

@Module({
  imports: [
    // 환경변수 설정
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, appConfig],
    }),

    // TypeORM 설정
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'mysql',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.username,
          password: dbConfig.password,
          database: dbConfig.database,
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          synchronize: false,
          logging: dbConfig.logging,
          // 커넥션 풀 설정
          extra: {
            connectionLimit: dbConfig.poolSize,
            waitForConnections: true,
            queueLimit: dbConfig.queueLimit,
          },
          poolSize: dbConfig.poolSize,
        };
      },
    }),

    // 기능 모듈
    ScenariosModule,
    MetricsModule,
    HealthModule,
  ],
})
export class AppModule {}
