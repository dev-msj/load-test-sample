import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface DatabaseMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  acquireTime: {
    avg: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
  };
}

export interface LibuvMetrics {
  threadPoolSize: number;
  activeHandles: number;
  activeRequests: number;
}

export interface ApplicationMetrics {
  requestsPerSecond: number;
  totalRequests: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  errorRate: number;
  totalErrors: number;
  uptime: number;
}

export interface ProcessMetrics {
  cpu: {
    user: number; // CPU 사용 시간 (마이크로초)
    system: number; // 시스템 CPU 사용 시간 (마이크로초)
    percent: number; // CPU 사용률 (%)
  };
  memory: {
    rss: number; // Resident Set Size (MB)
    heapTotal: number; // V8 힙 전체 크기 (MB)
    heapUsed: number; // V8 힙 사용량 (MB)
    external: number; // V8 외부 메모리 (MB)
    arrayBuffers: number; // ArrayBuffer 메모리 (MB)
    percentUsed: number; // 힙 사용률 (%)
  };
}

export interface AllMetrics {
  database: DatabaseMetrics;
  libuv: LibuvMetrics;
  application: ApplicationMetrics;
  process: ProcessMetrics;
  timestamp: string;
}

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);

  // 메트릭 수집용 데이터
  private acquireTimes: number[] = [];
  private responseTimes: number[] = [];
  private requestCount = 0;
  private errorCount = 0;
  private startTime: number;
  private lastResetTime: number;

  // CPU 사용량 추적
  private lastCpuUsage: NodeJS.CpuUsage;
  private lastCpuTime: number;

  private readonly maxSamples = 1000;

  constructor(private dataSource: DataSource) {
    this.startTime = Date.now();
    this.lastResetTime = Date.now();
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
  }

  onModuleInit() {
    this.logger.log('MetricsService initialized');
  }

  /**
   * DB 커넥션 획득 시간 기록
   */
  recordAcquireTime(ms: number): void {
    this.acquireTimes.push(ms);
    if (this.acquireTimes.length > this.maxSamples) {
      this.acquireTimes.shift();
    }
  }

  /**
   * 요청 응답 시간 기록
   */
  recordResponseTime(ms: number, isError: boolean = false): void {
    this.requestCount++;
    if (isError) {
      this.errorCount++;
    }

    this.responseTimes.push(ms);
    if (this.responseTimes.length > this.maxSamples) {
      this.responseTimes.shift();
    }
  }

  /**
   * 전체 메트릭 수집
   */
  async collectAllMetrics(): Promise<AllMetrics> {
    return {
      database: await this.collectDatabaseMetrics(),
      libuv: this.collectLibuvMetrics(),
      application: this.collectApplicationMetrics(),
      process: this.collectProcessMetrics(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 데이터베이스 커넥션 풀 메트릭 수집
   */
  async collectDatabaseMetrics(): Promise<DatabaseMetrics> {
    try {
      // mysql2 드라이버의 Pool 객체 접근
      const driver = this.dataSource.driver as any;
      const pool = driver.pool;

      if (!pool) {
        return this.getEmptyDatabaseMetrics();
      }

      // mysql2 Pool 내부 상태 추출
      const allConnections = pool._allConnections?.length || 0;
      const freeConnections = pool._freeConnections?.length || 0;
      const connectionQueue = pool._connectionQueue?.length || 0;

      return {
        totalConnections: allConnections,
        activeConnections: allConnections - freeConnections,
        idleConnections: freeConnections,
        waitingRequests: connectionQueue,
        acquireTime: this.calculatePercentiles(this.acquireTimes),
      };
    } catch (error) {
      this.logger.warn(`Failed to collect database metrics: ${error.message}`);
      return this.getEmptyDatabaseMetrics();
    }
  }

  /**
   * libuv 스레드 풀 메트릭 수집
   */
  collectLibuvMetrics(): LibuvMetrics {
    return {
      threadPoolSize: parseInt(process.env.UV_THREADPOOL_SIZE || '4', 10),
      activeHandles: this.getActiveHandles(),
      activeRequests: this.getActiveRequests(),
    };
  }

  /**
   * 애플리케이션 메트릭 수집
   */
  collectApplicationMetrics(): ApplicationMetrics {
    const elapsedSeconds = (Date.now() - this.lastResetTime) / 1000;
    const rps = elapsedSeconds > 0 ? this.requestCount / elapsedSeconds : 0;
    const errorRate =
      this.requestCount > 0 ? this.errorCount / this.requestCount : 0;

    const responseTimeStats = this.calculatePercentiles(this.responseTimes);

    return {
      requestsPerSecond: Math.round(rps * 100) / 100,
      totalRequests: this.requestCount,
      avgResponseTime: responseTimeStats.avg,
      p95ResponseTime: responseTimeStats.p95,
      p99ResponseTime: responseTimeStats.p99,
      errorRate: Math.round(errorRate * 10000) / 10000,
      totalErrors: this.errorCount,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }

  /**
   * 프로세스 리소스 메트릭 수집 (CPU, 메모리)
   */
  collectProcessMetrics(): ProcessMetrics {
    // CPU 사용량 계산
    const currentCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const currentTime = Date.now();
    const elapsedMs = currentTime - this.lastCpuTime;

    // CPU 사용률 계산 (user + system time / elapsed time)
    // cpuUsage는 마이크로초 단위
    const totalCpuMs = (currentCpuUsage.user + currentCpuUsage.system) / 1000;
    const cpuPercent = elapsedMs > 0 ? (totalCpuMs / elapsedMs) * 100 : 0;

    // 다음 측정을 위해 저장
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = currentTime;

    // 메모리 사용량
    const memUsage = process.memoryUsage();
    const toMB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;

    return {
      cpu: {
        user: currentCpuUsage.user,
        system: currentCpuUsage.system,
        percent: Math.round(cpuPercent * 100) / 100,
      },
      memory: {
        rss: toMB(memUsage.rss),
        heapTotal: toMB(memUsage.heapTotal),
        heapUsed: toMB(memUsage.heapUsed),
        external: toMB(memUsage.external),
        arrayBuffers: toMB(memUsage.arrayBuffers || 0),
        percentUsed:
          Math.round((memUsage.heapUsed / memUsage.heapTotal) * 10000) / 100,
      },
    };
  }

  /**
   * 메트릭 리셋
   */
  reset(): void {
    this.acquireTimes = [];
    this.responseTimes = [];
    this.requestCount = 0;
    this.errorCount = 0;
    this.lastResetTime = Date.now();
  }

  // 헬퍼 메서드들

  private calculatePercentiles(data: number[]): {
    avg: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
  } {
    if (data.length === 0) {
      return { avg: 0, p95: 0, p99: 0, min: 0, max: 0 };
    }

    const sorted = [...data].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;

    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);

    return {
      avg: Math.round(avg * 100) / 100,
      p95: sorted[p95Index] || sorted[sorted.length - 1],
      p99: sorted[p99Index] || sorted[sorted.length - 1],
      min: sorted[0],
      max: sorted[sorted.length - 1],
    };
  }

  private getActiveHandles(): number {
    try {
      const handles = (process as any)._getActiveHandles?.();
      return handles?.length || 0;
    } catch {
      return 0;
    }
  }

  private getActiveRequests(): number {
    try {
      const requests = (process as any)._getActiveRequests?.();
      return requests?.length || 0;
    } catch {
      return 0;
    }
  }

  private getEmptyDatabaseMetrics(): DatabaseMetrics {
    return {
      totalConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      acquireTime: { avg: 0, p95: 0, p99: 0, min: 0, max: 0 },
    };
  }
}
