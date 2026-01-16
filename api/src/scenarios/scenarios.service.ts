import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { User, Product, Order, OrderItem, FileRecord } from '../database/entities';

@Injectable()
export class ScenariosService {
  private readonly logger = new Logger(ScenariosService.name);
  private readonly tempDir: string;
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(Order)
    private orderRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemRepository: Repository<OrderItem>,
    @InjectRepository(FileRecord)
    private fileRecordRepository: Repository<FileRecord>,
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {
    this.tempDir = this.configService.get('app.tempDir') || '/tmp/uploads';
    this.bcryptRounds = this.configService.get('app.bcryptRounds') || 12;
  }

  /**
   * 시나리오 A: 단순 쿼리
   * PK로 단일 건 조회
   */
  async simpleQuery(userId: number) {
    const acquireStart = Date.now();
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });
    const acquireTime = Date.now() - acquireStart;

    return {
      user: user
        ? {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt,
          }
        : null,
      acquireTime,
    };
  }

  /**
   * 시나리오 B: 복잡한 쿼리
   * JOIN 3개 이상, 집계 함수 포함 (TypeORM QueryBuilder 사용)
   */
  async complexQuery(userId?: number, delayMs: number = 100) {
    // 인위적 지연 추가 (실제 느린 쿼리 시뮬레이션)
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // TypeORM QueryBuilder로 복잡한 쿼리 실행
    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.orders', 'order')
      .leftJoinAndSelect('order.orderItems', 'orderItem')
      .leftJoinAndSelect('orderItem.product', 'product')
      .select('user.id', 'userId')
      .addSelect('user.name', 'userName')
      .addSelect('COUNT(DISTINCT order.id)', 'totalOrders')
      .addSelect('COUNT(orderItem.id)', 'totalItems')
      .addSelect('COALESCE(SUM(orderItem.quantity * orderItem.unitPrice), 0)', 'totalSpent')
      .addSelect('COALESCE(AVG(orderItem.unitPrice), 0)', 'avgItemPrice')
      .addSelect('MIN(order.orderDate)', 'firstOrder')
      .addSelect('MAX(order.orderDate)', 'lastOrder')
      .groupBy('user.id')
      .addGroupBy('user.name')
      .orderBy('totalSpent', 'DESC')
      .limit(10);

    if (userId) {
      queryBuilder.where('user.id = :userId', { userId });
    } else {
      queryBuilder.where('user.id <= :maxUserId', { maxUserId: 1000 });
    }

    const result = await queryBuilder.getRawMany();

    return {
      summary: result.map((row) => ({
        userId: row.userId,
        userName: row.userName,
        totalOrders: parseInt(row.totalOrders, 10) || 0,
        totalItems: parseInt(row.totalItems, 10) || 0,
        totalSpent: parseFloat(row.totalSpent) || 0,
        avgItemPrice: parseFloat(row.avgItemPrice) || 0,
        firstOrder: row.firstOrder,
        lastOrder: row.lastOrder,
      })),
      queryDelay: delayMs,
    };
  }

  /**
   * 시나리오 C: CPU 집약 작업
   * bcrypt 해싱 + JSON 대량 파싱
   */
  async cpuIntensive(params: {
    password: string;
    jsonSize: number;
    rounds?: number;
  }) {
    const rounds = params.rounds || this.bcryptRounds;

    // 1. bcrypt 해싱 (libuv 스레드 풀 사용)
    const hashStart = Date.now();
    const hash = await bcrypt.hash(params.password, rounds);
    const hashTime = Date.now() - hashStart;

    // 2. JSON 대량 파싱 (CPU 바운드)
    const parseStart = Date.now();
    const largeObject = this.generateLargeObject(params.jsonSize);
    const jsonString = JSON.stringify(largeObject);
    const parsed = JSON.parse(jsonString);
    const parseTime = Date.now() - parseStart;

    // 3. 해시 검증 (추가 CPU 작업)
    const verifyStart = Date.now();
    const isValid = await bcrypt.compare(params.password, hash);
    const verifyTime = Date.now() - verifyStart;

    return {
      hashTime,
      parseTime,
      verifyTime,
      totalTime: hashTime + parseTime + verifyTime,
      jsonSize: params.jsonSize,
      bcryptRounds: rounds,
      isValid,
      hashLength: hash.length,
      parsedKeys: Object.keys(parsed).length,
    };
  }

  /**
   * 시나리오 D: 파일 I/O + DB
   * 파일 읽기/쓰기 + DB 저장 (TypeORM Repository 사용)
   */
  async fileAndDb(params: {
    content?: string;
    filename?: string;
    fileSize?: number;
  }) {
    const filename = params.filename || `file_${uuidv4()}.txt`;
    const filePath = path.join(this.tempDir, filename);

    // 1. 파일 내용 생성 또는 사용
    const content =
      params.content || this.generateRandomContent(params.fileSize || 1024);

    // 2. 파일 쓰기 (libuv 스레드 풀 사용)
    const writeStart = Date.now();
    await fs.mkdir(this.tempDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    const writeTime = Date.now() - writeStart;

    // 3. 파일 읽기
    const readStart = Date.now();
    const readContent = await fs.readFile(filePath, 'utf-8');
    const readTime = Date.now() - readStart;

    // 4. DB에 파일 정보 저장 (TypeORM Repository 사용)
    const dbStart = Date.now();
    const contentHash = this.simpleHash(readContent);

    const fileRecord = this.fileRecordRepository.create({
      filename,
      fileSize: readContent.length,
      contentHash,
    });
    await this.fileRecordRepository.save(fileRecord);
    const dbTime = Date.now() - dbStart;

    // 5. 파일 삭제 (정리)
    await fs.unlink(filePath);

    return {
      filename,
      fileSize: readContent.length,
      contentHash,
      writeTime,
      readTime,
      dbTime,
      totalTime: writeTime + readTime + dbTime,
      recordId: fileRecord.id,
    };
  }

  /**
   * 시나리오 E: 외부 API 호출 시뮬레이션
   * setTimeout으로 지연 시뮬레이션
   */
  async externalApi(
    baseDelay: number = 200,
    randomize: boolean = true,
  ): Promise<any> {
    // 실제 지연 시간 계산 (100~300ms 범위 내 랜덤화)
    const actualDelay = randomize
      ? Math.floor(baseDelay * 0.5 + Math.random() * baseDelay)
      : baseDelay;

    const startTime = Date.now();

    // Promise로 지연 시뮬레이션 (논블로킹)
    await new Promise((resolve) => setTimeout(resolve, actualDelay));

    const endTime = Date.now();

    return {
      requestedDelay: baseDelay,
      actualDelay: endTime - startTime,
      randomized: randomize,
      simulatedResponse: {
        status: 'success',
        data: {
          externalId: uuidv4(),
          timestamp: new Date().toISOString(),
          processed: true,
        },
      },
    };
  }

  /**
   * 시나리오 F: 혼합 워크로드
   * 가중치에 따라 랜덤하게 시나리오 선택 및 실행
   */
  async mixed(weights?: {
    simple?: number;
    complex?: number;
    cpu?: number;
    file?: number;
    external?: number;
  }) {
    const defaultWeights = {
      simple: 40,
      complex: 20,
      cpu: 15,
      file: 10,
      external: 15,
    };

    const w = { ...defaultWeights, ...weights };
    const total = w.simple + w.complex + w.cpu + w.file + w.external;
    const random = Math.random() * total;

    let selectedScenario: string;
    let result: any;

    if (random < w.simple) {
      selectedScenario = 'simple';
      result = await this.simpleQuery(
        Math.floor(Math.random() * 100000) + 1,
      );
    } else if (random < w.simple + w.complex) {
      selectedScenario = 'complex';
      result = await this.complexQuery(undefined, 50);
    } else if (random < w.simple + w.complex + w.cpu) {
      selectedScenario = 'cpu';
      result = await this.cpuIntensive({
        password: 'mixedTest',
        jsonSize: 5000,
        rounds: 10,
      });
    } else if (random < w.simple + w.complex + w.cpu + w.file) {
      selectedScenario = 'file';
      result = await this.fileAndDb({ fileSize: 512 });
    } else {
      selectedScenario = 'external';
      result = await this.externalApi(100, true);
    }

    return {
      selectedScenario,
      weights: w,
      result,
    };
  }

  /**
   * 시나리오 G: 풀 고갈
   * 트랜잭션 내에서 커넥션을 지정된 시간 동안 점유 (TypeORM Transaction 사용)
   */
  async poolExhaustion(holdTimeMs: number = 5000) {
    const queryRunner = this.dataSource.createQueryRunner();
    const startTime = Date.now();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();
      this.logger.warn(`Transaction started, holding for ${holdTimeMs}ms`);

      // 1. 트랜잭션 내에서 여러 ORM 작업 수행
      const userRepo = queryRunner.manager.getRepository(User);
      const orderRepo = queryRunner.manager.getRepository(Order);

      // 랜덤 사용자 조회
      const randomUserId = Math.floor(Math.random() * 100000) + 1;
      const user = await userRepo.findOne({ where: { id: randomUserId } });

      // 사용자의 주문 조회 (relations 사용)
      const orders = await orderRepo.find({
        where: { userId: randomUserId },
        relations: ['orderItems'],
        take: 10,
      });

      // 2. 남은 시간 동안 지연 (커넥션 점유 유지)
      const elapsed = Date.now() - startTime;
      const remainingTime = Math.max(0, holdTimeMs - elapsed);
      if (remainingTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingTime));
      }

      // 3. 트랜잭션 커밋
      await queryRunner.commitTransaction();
      const actualHoldTime = Date.now() - startTime;

      return {
        message: 'Connection held successfully',
        requestedHoldTime: holdTimeMs,
        actualHoldTime,
        released: true,
        userData: user ? { id: user.id, name: user.name } : null,
        ordersFound: orders.length,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
      this.logger.warn('Connection released');
    }
  }

  // 헬퍼 메서드들

  private generateLargeObject(size: number): Record<string, any> {
    const obj: Record<string, any> = {};
    for (let i = 0; i < size; i++) {
      obj[`key_${i}`] = {
        value: Math.random(),
        nested: {
          a: i,
          b: `string_${i}`,
          c: [1, 2, 3, 4, 5],
        },
      };
    }
    return obj;
  }

  private generateRandomContent(size: number): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < size; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }
}
