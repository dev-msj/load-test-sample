import { Controller, Get, Logger } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('api/metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(private readonly metricsService: MetricsService) {}

  /**
   * 전체 풀 상태 메트릭 조회
   * GET /api/metrics/pools
   */
  @Get('pools')
  async getPools() {
    return this.metricsService.collectAllMetrics();
  }

  /**
   * 데이터베이스 커넥션 풀 상태만 조회
   * GET /api/metrics/database
   */
  @Get('database')
  async getDatabaseMetrics() {
    return this.metricsService.collectDatabaseMetrics();
  }

  /**
   * libuv 스레드 풀 상태만 조회
   * GET /api/metrics/libuv
   */
  @Get('libuv')
  async getLibuvMetrics() {
    return this.metricsService.collectLibuvMetrics();
  }

  /**
   * 애플리케이션 메트릭만 조회
   * GET /api/metrics/application
   */
  @Get('application')
  async getApplicationMetrics() {
    return this.metricsService.collectApplicationMetrics();
  }

  /**
   * 메트릭 리셋 (테스트용)
   * GET /api/metrics/reset
   */
  @Get('reset')
  async resetMetrics() {
    this.metricsService.reset();
    this.logger.log('Metrics reset');
    return { message: 'Metrics reset successfully' };
  }
}
