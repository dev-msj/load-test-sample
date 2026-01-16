import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ScenariosService } from './scenarios.service';

@Controller('api/scenarios')
export class ScenariosController {
  private readonly logger = new Logger(ScenariosController.name);

  constructor(private readonly scenariosService: ScenariosService) {}

  /**
   * 시나리오 A: 단순 쿼리 (빠른 I/O)
   * PK로 단일 건 조회, 예상 응답시간 5~10ms
   */
  @Get('simple-query')
  async simpleQuery(@Query('id') id: string) {
    const startTime = Date.now();
    const userId = parseInt(id, 10) || Math.floor(Math.random() * 100000) + 1;

    try {
      const result = await this.scenariosService.simpleQuery(userId);
      const duration = Date.now() - startTime;

      this.logger.debug(`simple-query completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'SIMPLE_QUERY_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 B: 복잡한 쿼리 (느린 I/O)
   * JOIN 3개 이상, 집계 함수 포함, 예상 응답시간 100~200ms
   */
  @Get('complex-query')
  async complexQuery(
    @Query('userId') userId?: string,
    @Query('delay') delay?: string,
  ) {
    const startTime = Date.now();
    const userIdNum = userId ? parseInt(userId, 10) : undefined;
    const delayMs = delay ? parseInt(delay, 10) : 100;

    try {
      const result = await this.scenariosService.complexQuery(
        userIdNum,
        delayMs,
      );
      const duration = Date.now() - startTime;

      this.logger.debug(`complex-query completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'COMPLEX_QUERY_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 C: CPU 집약 작업
   * bcrypt 해싱, JSON 대량 파싱 등 (libuv 스레드 풀 사용)
   */
  @Post('cpu-intensive')
  async cpuIntensive(
    @Body() body: { password?: string; jsonSize?: number; rounds?: number },
  ) {
    const startTime = Date.now();

    try {
      const result = await this.scenariosService.cpuIntensive({
        password: body.password || 'defaultPassword123',
        jsonSize: body.jsonSize || 10000,
        rounds: body.rounds,
      });
      const duration = Date.now() - startTime;

      this.logger.debug(`cpu-intensive completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'CPU_INTENSIVE_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 D: 파일 I/O + DB
   * 파일 읽기/쓰기 (fs 모듈 사용) + DB 저장
   */
  @Post('file-and-db')
  async fileAndDb(
    @Body() body: { content?: string; filename?: string; fileSize?: number },
  ) {
    const startTime = Date.now();

    try {
      const result = await this.scenariosService.fileAndDb({
        content: body.content,
        filename: body.filename,
        fileSize: body.fileSize || 1024,
      });
      const duration = Date.now() - startTime;

      this.logger.debug(`file-and-db completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'FILE_AND_DB_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 E: 외부 API 호출 시뮬레이션
   * setTimeout으로 100~300ms 지연 시뮬레이션
   */
  @Get('external-api')
  async externalApi(
    @Query('delay') delay?: string,
    @Query('randomize') randomize?: string,
  ) {
    const startTime = Date.now();
    const baseDelay = delay ? parseInt(delay, 10) : 200;
    const shouldRandomize = randomize !== 'false';

    try {
      const result = await this.scenariosService.externalApi(
        baseDelay,
        shouldRandomize,
      );
      const duration = Date.now() - startTime;

      this.logger.debug(`external-api completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'EXTERNAL_API_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 F: 혼합 워크로드
   * 위 시나리오들을 랜덤 비율로 조합
   */
  @Post('mixed')
  async mixed(
    @Body()
    body: {
      weights?: {
        simple?: number;
        complex?: number;
        cpu?: number;
        file?: number;
        external?: number;
      };
    },
  ) {
    const startTime = Date.now();

    try {
      const result = await this.scenariosService.mixed(body.weights);
      const duration = Date.now() - startTime;

      this.logger.debug(`mixed completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'MIXED_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 시나리오 G: 풀 고갈 시나리오
   * 커넥션을 오래 점유하여 풀 고갈 상황 유발
   */
  @Get('pool-exhaustion')
  async poolExhaustion(@Query('holdTime') holdTime?: string) {
    const startTime = Date.now();
    const holdTimeMs = holdTime ? parseInt(holdTime, 10) : 5000;

    this.logger.warn(`pool-exhaustion started, holding for ${holdTimeMs}ms`);

    try {
      const result = await this.scenariosService.poolExhaustion(holdTimeMs);
      const duration = Date.now() - startTime;

      this.logger.warn(`pool-exhaustion completed in ${duration}ms`);

      return {
        success: true,
        data: result,
        timing: { duration },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          error: error.message,
          code: 'POOL_EXHAUSTION_ERROR',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
