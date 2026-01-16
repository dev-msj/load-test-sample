import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // bcrypt 설정
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),

  // libuv 스레드 풀 사이즈 (환경변수로 설정됨)
  uvThreadPoolSize: parseInt(process.env.UV_THREADPOOL_SIZE || '4', 10),

  // Graceful shutdown 타임아웃
  shutdownTimeout: parseInt(process.env.SHUTDOWN_TIMEOUT || '30000', 10),

  // 임시 파일 디렉토리
  tempDir: process.env.TEMP_DIR || '/tmp/uploads',
}));
