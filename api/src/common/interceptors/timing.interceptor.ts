import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from '../../metrics/metrics.service';

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimingInterceptor.name);

  constructor(private metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - startTime;
          this.metricsService.recordResponseTime(duration, false);

          // 느린 요청 로깅 (500ms 초과)
          if (duration > 500) {
            this.logger.warn(`Slow request: ${method} ${url} - ${duration}ms`);
          }
        },
        error: (error) => {
          const duration = Date.now() - startTime;
          this.metricsService.recordResponseTime(duration, true);
          this.logger.error(
            `Request error: ${method} ${url} - ${duration}ms - ${error.message}`,
          );
        },
      }),
    );
  }
}
