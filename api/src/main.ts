import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { DataSource } from 'typeorm';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Graceful shutdown 활성화
  app.enableShutdownHooks();

  const dataSource = app.get(DataSource);

  // Graceful shutdown 핸들러
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}. Starting graceful shutdown...`);

    const timeout = parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10);
    const shutdownTimer = setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, timeout);

    try {
      // 1. 새로운 요청 수신 중단
      await app.close();
      logger.log('HTTP server closed.');

      // 2. DB 커넥션 정리
      if (dataSource.isInitialized) {
        logger.log('Closing database connections...');
        await dataSource.destroy();
        logger.log('Database connections closed.');
      }

      clearTimeout(shutdownTimer);
      logger.log('Graceful shutdown completed.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      clearTimeout(shutdownTimer);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`Application running on port ${port}`);
  logger.log(`UV_THREADPOOL_SIZE: ${process.env.UV_THREADPOOL_SIZE || 4}`);
  logger.log(`DB_POOL_SIZE: ${process.env.DB_POOL_SIZE || 10}`);
}

bootstrap();
