import { registerAs } from '@nestjs/config';

export default registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || 'pool_tuning',

  // 커넥션 풀 설정 (튜닝 대상)
  poolSize: parseInt(process.env.DB_POOL_SIZE || '10', 10),
  acquireTimeout: parseInt(process.env.DB_POOL_ACQUIRE_TIMEOUT || '10000', 10),
  idleTimeout: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT || '0', 10),

  // 로깅 설정
  logging: process.env.DB_LOGGING === 'true',
}));
