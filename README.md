# 스레드/커넥션 풀 튜닝 실습 환경

1000~2000 TPS 부하를 시뮬레이션하여 **커넥션 풀**과 **스레드 풀(libuv)** 튜닝 효과를 직접 관찰하고 학습할 수 있는 환경입니다.

## 기술 스택

- **Backend**: NestJS (Node.js)
- **Database**: MySQL 8.0
- **ORM**: TypeORM
- **Container**: Docker, Docker Compose
- **Load Testing**: k6
- **Thread Pool**: libuv (UV_THREADPOOL_SIZE)

---

# 이 실습의 목적

## 왜 이 실습을 하는가?

풀 튜닝은 이론만으로는 이해하기 어렵습니다. **직접 병목 현상을 만들고, 설정을 바꿔가며 차이를 관찰**해야 체득할 수 있습니다.

이 실습 환경은:
1. **의도적으로 부족한 설정**에서 시작하여 문제 상황을 만들고
2. **메트릭을 통해 병목을 확인**한 뒤
3. **설정을 조정하여 개선 효과를 관찰**하는

과정을 반복하며 풀 튜닝의 원리를 체득하도록 설계되었습니다.

## Node.js에서의 커넥션 풀 이해

### Java vs Node.js의 차이

| 항목 | Java (Spring) | Node.js |
|------|---------------|---------|
| I/O 모델 | 동기 블로킹 | 비동기 논블로킹 |
| 스레드 | 요청당 1개 스레드 | 단일 이벤트 루프 |
| 커넥션 풀 공식 | `CPU 코어 × 2 + 1` | `TPS × 평균 쿼리 시간(초)` |

Java에서 유명한 `CPU 코어 × 2 + 1` 공식은 **동기 블로킹 I/O** 환경에서 유효합니다.
Node.js는 **비동기 논블로킹 I/O**를 사용하므로, CPU 코어 수가 아닌 **실제 부하**를 기준으로 계산해야 합니다.

### Node.js 커넥션 풀 계산 공식

```
필요 커넥션 수 = TPS × 평균 쿼리 시간(초)
```

#### 계산 예시

| TPS | 쿼리 시간 | 필요 커넥션 |
|-----|----------|------------|
| 500 | 10ms | 500 × 0.01 = **5개** |
| 500 | 100ms | 500 × 0.1 = **50개** |
| 1000 | 10ms | 1000 × 0.01 = **10개** |
| 1000 | 50ms | 1000 × 0.05 = **50개** |
| 2000 | 100ms | 2000 × 0.1 = **200개** |

#### 핵심 인사이트

- **쿼리가 빠르면** 적은 커넥션으로 높은 TPS 처리 가능
- **쿼리가 느리면** 같은 TPS에도 훨씬 많은 커넥션 필요
- 따라서 **쿼리 최적화**가 커넥션 풀 사이즈보다 중요할 수 있음

### 실습에서 의도적으로 작은 값을 사용하는 이유

실습에서 `DB_POOL_SIZE=5`처럼 작은 값으로 시작하는 이유:

1. **병목 현상 관찰**: 커넥션이 부족하면 `waitingRequests`가 증가하는 것을 눈으로 확인
2. **튜닝 효과 체감**: 5 → 20으로 늘렸을 때 응답 시간이 개선되는 것을 직접 확인
3. **적정값 찾기 연습**: 무조건 크게 설정하는 것이 아닌, 부하에 맞는 값을 찾는 연습

---

# 빠른 시작

### 1. 환경변수 설정

```bash
# .env.example을 .env로 복사
copy .env.example .env
```

### 2. 환경 실행

```bash
# 기본 설정으로 실행
docker-compose up -d

# 로그 확인
docker-compose logs -f api
```

### 3. 헬스 체크

```bash
curl http://localhost:3000/health
```

### 4. 부하 테스트 실행

```powershell
# Docker로 k6 실행 (기본: simple-query 시나리오)
docker-compose --profile test run --rm k6

# 다른 시나리오 실행
$env:K6_SCENARIO="cpu-intensive"; docker-compose --profile test run --rm k6

# 결과 확인 (테스트 완료 후)
ls ./k6-results/
cat ./k6-results/simple-query_conn-20_thread-4.json
```

**사용 가능한 시나리오** (`K6_SCENARIO` 환경변수):
| 값 | 설명 |
|----|------|
| `simple-query` | 단순 PK 조회 (기본값) |
| `complex-query` | 복잡한 JOIN 쿼리 |
| `cpu-intensive` | bcrypt + JSON 파싱 |
| `file-and-db` | 파일 I/O + DB |
| `external-api` | 외부 API 시뮬레이션 |
| `mixed` | 랜덤 혼합 워크로드 |

> **참고**: 테스트 결과는 `./k6-results/{시나리오}_conn-{커넥션풀}_thread-{스레드풀}.json` 형식으로 저장됩니다.
> 예: `simple-query_conn-5_thread-4.json`

---

# 프로젝트 구조

```
pool-tuning-lab/
├── docker-compose.yml          # 서비스 오케스트레이션
├── .env.example                # 환경변수 템플릿
├── api/                        # NestJS 애플리케이션
│   ├── src/
│   │   ├── scenarios/          # 7개 API 시나리오
│   │   ├── metrics/            # 풀 상태 모니터링
│   │   └── config/             # 환경 설정
│   └── Dockerfile
├── mysql/                      # MySQL 초기화
│   ├── init.sql                # 스키마 생성
│   └── seed-data.sql           # 160만건 더미 데이터
└── k6/                         # 부하 테스트
    ├── scenarios/              # 시나리오별 스크립트
    └── profiles/               # ramp-up, stress, soak
```

---

# API 시나리오

| 시나리오 | 엔드포인트 | 설명 | 예상 응답시간 |
|---------|-----------|------|-------------|
| A. 단순 쿼리 | `GET /api/scenarios/simple-query?id={id}` | PK 조회 | 5~10ms |
| B. 복잡한 쿼리 | `GET /api/scenarios/complex-query?delay={ms}` | 3+ JOIN, 집계 | 100~200ms |
| C. CPU 집약 | `POST /api/scenarios/cpu-intensive` | bcrypt, JSON 파싱 | 300~500ms |
| D. 파일 I/O + DB | `POST /api/scenarios/file-and-db` | fs 모듈 + DB | 50~100ms |
| E. 외부 API | `GET /api/scenarios/external-api?delay={ms}` | 지연 시뮬레이션 | 100~300ms |
| F. 혼합 워크로드 | `POST /api/scenarios/mixed` | 랜덤 조합 | 가변 |
| G. 풀 고갈 | `GET /api/scenarios/pool-exhaustion?holdTime={ms}` | 커넥션 점유 | {holdTime}ms |

### 메트릭 엔드포인트

```bash
curl http://localhost:3000/api/metrics/pools
```

응답 예시:
```json
{
  "database": {
    "totalConnections": 10,
    "activeConnections": 7,
    "idleConnections": 3,
    "waitingRequests": 12,
    "acquireTime": { "avg": 45, "p95": 120, "p99": 250 }
  },
  "libuv": {
    "threadPoolSize": 4,
    "activeHandles": 15,
    "activeRequests": 8
  },
  "application": {
    "requestsPerSecond": 1250,
    "avgResponseTime": 85,
    "errorRate": 0.02
  }
}
```

---

# 환경변수 설정 방법 (Windows)

Windows에서는 환경변수를 설정하는 방법이 다릅니다.

## 방법 1: .env 파일 수정 (권장)

```bash
# 1. .env 파일을 에디터로 열어서 값 수정
notepad .env

# 2. 예: DB_POOL_SIZE=5 로 변경 후 저장

# 3. 컨테이너 재시작
docker-compose down
docker-compose up -d
```

## 방법 2: PowerShell 사용

```powershell
# 환경변수 설정 후 실행
$env:DB_POOL_SIZE=5; docker-compose up -d

# 여러 변수 설정
$env:DB_POOL_SIZE=5; $env:UV_THREADPOOL_SIZE=16; docker-compose up -d
```

## 방법 3: CMD 사용

```cmd
# 환경변수 설정 후 실행
set DB_POOL_SIZE=5 && docker-compose up -d

# 여러 변수 설정
set DB_POOL_SIZE=5 && set UV_THREADPOOL_SIZE=16 && docker-compose up -d
```

---

# 실습 가이드

## 실습 1: 커넥션 풀 부족 현상 관찰

### 목적
**의도적으로 커넥션을 부족하게 설정**하여 병목 현상을 직접 관찰합니다.
메트릭에서 `waitingRequests`가 증가하고 응답 시간이 느려지는 것을 확인합니다.

### 배경 지식
```
필요 커넥션 수 = TPS × 평균 쿼리 시간(초)
```
100 VUs가 10ms 쿼리를 보내면 약 10개 커넥션이 필요합니다.
5개로 제한하면 부족 현상이 발생합니다.

### 실습 단계

**Step 1: 커넥션 5개로 제한 (의도적으로 부족하게)**

```powershell
# .env 파일에서 DB_POOL_SIZE=5 로 수정 후
docker-compose down
docker-compose up -d

# 부하 테스트 실행
docker-compose --profile test run --rm k6
```

또는 PowerShell에서 환경변수로:
```powershell
$env:DB_POOL_SIZE=5; docker-compose up -d
docker-compose --profile test run --rm k6
```

**관찰할 메트릭:**
```powershell
curl http://localhost:3000/api/metrics/pools
```
- `waitingRequests > 0` → 커넥션 대기 발생
- `acquireTime.avg` 증가 → 커넥션 획득에 시간 소요

**Step 2: 커넥션 20개로 증가 (충분하게)**

```powershell
$env:DB_POOL_SIZE=20; docker-compose up -d
docker-compose --profile test run --rm k6
```

**Step 3: 결과 비교**

| 풀 사이즈 | waitingRequests | acquireTime.avg | P95 응답시간 |
|----------|-----------------|-----------------|-------------|
| 5개 (부족) | ? | ? ms | ? ms |
| 20개 (충분) | 0 | < 5ms | ? ms |

### 학습 포인트
- 커넥션이 부족하면 요청이 **대기 상태**가 됨
- 대기 시간이 응답 시간에 **직접 영향**
- 메트릭으로 병목을 **사전에 감지** 가능

---

## 실습 2: 쿼리 속도가 필요 커넥션 수에 미치는 영향

### 목적
**같은 커넥션 풀 사이즈**에서 쿼리 속도에 따라 처리량이 어떻게 달라지는지 관찰합니다.
느린 쿼리가 왜 커넥션 풀을 빠르게 고갈시키는지 이해합니다.

### 배경 지식
```
필요 커넥션 = TPS × 쿼리 시간(초)

쿼리 10ms:  100 TPS × 0.01 = 1개
쿼리 100ms: 100 TPS × 0.1  = 10개
```
같은 TPS에서 쿼리가 10배 느리면 커넥션도 10배 필요합니다.

### 실습 단계

**빠른 쿼리 (10ms) - 10개 커넥션으로 충분**

```powershell
$env:DB_POOL_SIZE=10; docker-compose up -d

# ramp-up 프로파일로 테스트 (단순 쿼리 위주)
docker-compose --profile test run --rm k6
```

**느린 쿼리 (100ms) - 10개 커넥션으로 부족**

```powershell
$env:DB_POOL_SIZE=10; docker-compose up -d

# complex-query 시나리오로 테스트
$env:K6_SCENARIO="complex-query"; docker-compose --profile test run --rm k6
```

### 예상 결과
| 쿼리 속도 | 필요 커넥션 | 설정값 10개로 충분? | waitingRequests |
|----------|------------|-------------------|-----------------|
| 10ms | ~1개 | 충분 | 0 |
| 100ms | ~10개 | **경계선** | 증가 가능 |

### 학습 포인트
- **쿼리 최적화**가 풀 사이즈 증가보다 효과적일 수 있음
- 느린 쿼리 하나가 전체 시스템을 병목시킬 수 있음
- 모니터링으로 느린 쿼리를 찾아내는 것이 중요

---

## 실습 3: libuv 스레드 풀 튜닝

### 목적
CPU 집약 작업(bcrypt)에서 `UV_THREADPOOL_SIZE`가 미치는 영향을 관찰합니다.
libuv 스레드 풀이 어떤 작업에 영향을 주는지 이해합니다.

### 배경 지식
libuv 스레드 풀이 사용되는 작업:
- 파일 I/O (`fs` 모듈)
- DNS 조회
- `crypto` 일부 함수
- `bcrypt` 같은 네이티브 애드온

기본값 4개는 대부분 충분하지만, 위 작업이 동시에 많이 발생하면 병목이 됩니다.

### 실습 단계

**Step 1: 기본값 (4개 스레드)**

```powershell
$env:UV_THREADPOOL_SIZE=4; docker-compose up -d

# cpu-intensive 시나리오로 테스트
$env:K6_SCENARIO="cpu-intensive"; docker-compose --profile test run --rm k6
```

**Step 2: 16개 스레드**

```powershell
$env:UV_THREADPOOL_SIZE=16; docker-compose up -d

$env:K6_SCENARIO="cpu-intensive"; docker-compose --profile test run --rm k6
```

**Step 3: 결과 비교**

| UV_THREADPOOL_SIZE | bcrypt 평균 시간 | 전체 응답 시간 |
|-------------------|-----------------|---------------|
| 4 | ? ms | ? ms |
| 16 | ? ms | ? ms |

### 관찰 포인트
- bcrypt 해싱 시간 변화
- `docker stats`로 CPU 사용률 확인
- 스레드 풀 증가의 한계점 (128 이상은 효과 미미)

---

## 실습 4: 병목 지점 진단하기

### 목적
메트릭을 분석하여 현재 병목이 **어디인지** 판단하는 방법을 배웁니다.

### 병목 진단 체크리스트

| 증상 | 가능한 병목 | 확인 방법 | 해결 |
|------|-----------|----------|------|
| `waitingRequests > 0` | DB 커넥션 풀 부족 | `/api/metrics/pools` | `DB_POOL_SIZE` 증가 |
| `acquireTime.p95 > 100ms` | DB 커넥션 풀 부족 | `/api/metrics/pools` | `DB_POOL_SIZE` 증가 |
| bcrypt 시간 증가 | libuv 스레드 풀 부족 | 응답 데이터 | `UV_THREADPOOL_SIZE` 증가 |
| CPU 100% | CPU 리소스 부족 | `docker stats` | bcrypt rounds 감소 또는 스케일 아웃 |

### 실시간 모니터링 명령어

```powershell
# PowerShell - 실시간 메트릭 확인
while ($true) {
    Clear-Host
    curl -s http://localhost:3000/api/metrics/pools | ConvertFrom-Json | ConvertTo-Json
    Start-Sleep 2
}

# Docker 리소스 모니터링
docker stats

# MySQL 커넥션 상태
docker exec -it load-test-sample-mysql-1 mysql -uroot -ppassword -e "SHOW PROCESSLIST"
```

---

## 실습 5: 적정 커넥션 풀 사이즈 찾기

### 목적
주어진 부하에서 **최적의 커넥션 풀 사이즈**를 찾는 방법을 연습합니다.

### 튜닝 프로세스

**1단계: 예상 부하 파악**
- 예상 TPS: 500
- 예상 쿼리 시간: 50ms
- 계산: 500 × 0.05 = **25개**

**2단계: 계산값으로 시작**
```powershell
$env:DB_POOL_SIZE=25; docker-compose up -d
docker-compose --profile test run --rm k6
```

**3단계: 메트릭 확인 후 조정**
- `waitingRequests > 0` → 풀 사이즈 증가
- `waitingRequests = 0` 이고 `idleConnections`가 많음 → 풀 사이즈 감소 가능

**4단계: 여유분 추가**
- 최종값 = 계산값 × 1.2 (20% 여유)
- 예: 25 × 1.2 = **30개**

### 권장 설정 가이드

| 환경 | TPS | 쿼리 시간 | 권장 풀 사이즈 |
|-----|-----|----------|--------------|
| 개발 | 10 | 10ms | 5 |
| 스테이징 | 100 | 30ms | 5~10 |
| 운영 (소규모) | 500 | 20ms | 15~20 |
| 운영 (대규모) | 2000 | 50ms | 100~150 |

---

# k6 테스트 스크립트

## Docker로 실행 (권장)

```powershell
# ramp-up 프로파일 실행 (기본)
docker-compose --profile test run --rm k6

# 결과 확인
cat ./k6-results/summary.json
```

> Docker 방식은 `ramp-up.js` 프로파일만 지원합니다.

## 로컬 k6로 실행

다양한 시나리오를 테스트하려면 로컬에 k6를 설치하세요.

### k6 설치 (Windows)

```powershell
# winget
winget install k6

# 또는 choco
choco install k6
```

### 프로파일

| 프로파일 | 설명 | 사용법 |
|---------|------|-------|
| ramp-up | 점진적 부하 증가 (50→100→200 VUs, 약 7분) | `k6 run k6/profiles/ramp-up.js` |
| stress | 한계점 찾기 | `k6 run k6/profiles/stress.js` |
| soak | 장시간 안정성 (30분) | `k6 run k6/profiles/soak.js` |

### 시나리오별 테스트

```powershell
# 단순 쿼리
k6 run k6/scenarios/simple-query.js --env VUS=100 --env DURATION=60s

# 복잡한 쿼리
k6 run k6/scenarios/complex-query.js --env VUS=50 --env DURATION=60s --env DELAY=100

# CPU 집약
k6 run k6/scenarios/cpu-intensive.js --env VUS=30 --env DURATION=60s

# 풀 고갈 테스트
k6 run k6/scenarios/pool-exhaustion.js --env VUS=20 --env HOLD_TIME=5000
```

---

# 트러블슈팅

### 문제: API가 시작되지 않음

```bash
# 로그 확인
docker-compose logs api

# MySQL 연결 대기
docker-compose logs mysql
```

### 문제: MySQL 더미 데이터 생성이 오래 걸림

초기 실행 시 약 5~10분 소요됩니다. 진행 상황 확인:

```bash
docker exec -it load-test-sample-mysql-1 mysql -uroot -ppassword -e "SELECT (SELECT COUNT(*) FROM pool_tuning.users) AS users, (SELECT COUNT(*) FROM pool_tuning.orders) AS orders"
```

### 문제: POOL_EXHAUSTED 에러

```powershell
# 커넥션 풀 사이즈 증가
$env:DB_POOL_SIZE=20; docker-compose up -d

# 또는 .env 파일 수정 후
docker-compose down && docker-compose up -d
```

---

# 환경변수 전체 목록

| 변수 | 기본값 | 설명 |
|-----|-------|------|
| `DB_POOL_SIZE` | 10 | 커넥션 풀 사이즈 |
| `DB_POOL_ACQUIRE_TIMEOUT` | 10000 | 커넥션 획득 타임아웃 (ms) |
| `DB_POOL_IDLE_TIMEOUT` | 30000 | 유휴 커넥션 타임아웃 (ms) |
| `UV_THREADPOOL_SIZE` | 4 | libuv 스레드 풀 사이즈 |
| `BCRYPT_ROUNDS` | 12 | bcrypt 해싱 라운드 |
| `DB_LOGGING` | false | DB 쿼리 로깅 |
| `SHUTDOWN_TIMEOUT` | 30000 | Graceful shutdown 타임아웃 (ms) |

---

# 핵심 요약

## 커넥션 풀 튜닝

```
필요 커넥션 = TPS × 쿼리 시간(초)
```

- `waitingRequests > 0` → 풀 사이즈 부족
- 쿼리 최적화가 풀 사이즈 증가보다 효과적

## libuv 스레드 풀 튜닝

- 파일 I/O, bcrypt 등 CPU 집약 작업에 영향
- 기본값 4, 필요시 8~32로 증가
- 128 이상은 효과 미미

## 모니터링

- `/api/metrics/pools`로 실시간 상태 확인
- `docker stats`로 리소스 사용량 확인

---

# 데이터베이스 스키마

| 테이블 | 레코드 수 | 용도 |
|-------|---------|------|
| users | 100,000 | 사용자 정보 |
| orders | 500,000 | 주문 정보 |
| products | 10,000 | 상품 정보 |
| order_items | ~1,000,000 | 주문 상세 |
| orders_no_index | 500,000 | 인덱스 없는 비교용 |

---

# 라이선스

MIT License
