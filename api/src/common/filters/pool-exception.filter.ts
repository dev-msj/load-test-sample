import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

// 커스텀 예외 클래스들
export class PoolExhaustedException extends Error {
  constructor(message: string = 'Connection pool exhausted') {
    super(message);
    this.name = 'PoolExhaustedException';
  }
}

export class QueryTimeoutException extends Error {
  constructor(message: string = 'Query execution timed out') {
    super(message);
    this.name = 'QueryTimeoutException';
  }
}

export class ConnectionAcquireException extends Error {
  constructor(message: string = 'Failed to acquire database connection') {
    super(message);
    this.name = 'ConnectionAcquireException';
  }
}

@Catch()
export class PoolExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PoolExceptionFilter.name);

  catch(exception: Error, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = exception.message;

    // 풀 관련 에러 처리
    if (
      exception instanceof PoolExhaustedException ||
      exception.message.includes('pool') ||
      exception.message.includes('POOL') ||
      exception.message.includes('connection limit')
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'POOL_EXHAUSTED';
      message = 'Database connection pool is exhausted. Please try again later.';
    }

    // 타임아웃 에러 처리
    if (
      exception instanceof QueryTimeoutException ||
      exception.message.includes('timeout') ||
      exception.message.includes('ETIMEDOUT') ||
      exception.message.includes('ECONNREFUSED')
    ) {
      status = HttpStatus.GATEWAY_TIMEOUT;
      code = 'QUERY_TIMEOUT';
      message = 'Database query timed out. Please try again.';
    }

    // 커넥션 획득 실패
    if (
      exception instanceof ConnectionAcquireException ||
      exception.message.includes('acquire') ||
      exception.message.includes('ECONNRESET')
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'CONNECTION_ACQUIRE_FAILED';
      message = 'Failed to acquire database connection.';
    }

    // MySQL 특정 에러
    if (exception.message.includes('ER_CON_COUNT_ERROR')) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'MAX_CONNECTIONS_EXCEEDED';
      message = 'Too many database connections. Please try again later.';
    }

    this.logger.error(
      `[${code}] ${request.method} ${request.url} - ${exception.message}`,
      exception.stack,
    );

    response.status(status).json({
      success: false,
      error: {
        code,
        message,
        timestamp: new Date().toISOString(),
        path: request.url,
      },
    });
  }
}
