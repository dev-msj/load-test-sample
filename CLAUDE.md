# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 프로젝트 개요

스레드/커넥션 풀 튜닝 실습 환경. 1000~2000 TPS 부하를 시뮬레이션하여 커넥션 풀과 libuv 스레드 풀 튜닝 효과를 관찰하는 학습용 프로젝트.

## 기술 스택

- Backend: NestJS 10 + TypeORM + MySQL 8
- 부하 테스트: k6 (Grafana)
- 인프라: Docker Compose

## 주요 명령어

### Docker 환경 실행

```bash
# 전체 서비스 시작
docker compose up -d

# 로그 확인
docker compose logs -f api

# 서비스 중지
docker compose down
```

### API 개발 (api/ 디렉토리)

```bash
cd api
npm run start:dev    # 개발 모드 (핫 리로드)
npm run build        # 빌드
npm run lint         # ESLint
npm run format       # Prettier
```

### k6 부하 테스트

```bash
# Ramp-Up 테스트 (~7분, 최대 200 VUs)
docker compose run --rm k6 run /scripts/profiles/ramp-up.js

# Stress 테스트 (~22분, 최대 3000 VUs)
docker compose run --rm k6 run /scripts/profiles/stress.js

# Soak 테스트 (~34분, 최대 500 VUs)
docker compose run --rm k6 run /scripts/profiles/soak.js

# 개별 시나리오 테스트
docker compose run --rm k6 run /scripts/scenarios/simple-query.js
```

### 베이스라인 기능

```bash
# 1. 베이스라인 수집 (~6분, 100 VUs)
docker compose run --rm k6 run -e SAVE_BASELINE=true /scripts/profiles/baseline.js

# 2. 베이스라인 비교 테스트 (기본 tolerance: 20%)
docker compose run --rm k6 run -e USE_BASELINE=true /scripts/profiles/ramp-up.js

# 3. tolerance 조정 (더 엄격하게)
docker compose run --rm k6 run -e USE_BASELINE=true -e BASELINE_TOLERANCE=10 /scripts/profiles/ramp-up.js
```

| 환경변수 | 기본값 | 설명 |
| - | - | - |
| `SAVE_BASELINE` | `false` | `true`면 결과를 `/results/baseline.json`에 저장 |
| `USE_BASELINE` | `false` | `true`면 베이스라인 기반 동적 threshold 적용 및 비교 리포트 생성 |
| `BASELINE_TOLERANCE` | `20` | 허용 편차 (%). P95가 100ms면 tolerance 20%일 때 threshold는 `p(95)<120` |

### SLA 평가 기능

모든 테스트 프로파일에서 자동으로 SLA(Service Level Agreement) 평가를 수행합니다. 결과는 마크다운 리포트와 JSON 파일로 출력됩니다.

```bash
# 1. 기본 SLA 테스트 (시나리오별 기본 SLA 적용)
docker compose run --rm k6 run /scripts/profiles/ramp-up.js

# 2. SLA 완화 테스트 (tolerance 20% 적용)
docker compose run --rm k6 run -e SLA_TOLERANCE=20 /scripts/profiles/ramp-up.js

# 3. 커스텀 SLA 테스트 (특정 기준 오버라이드)
docker compose run --rm k6 run -e 'SLA_OVERRIDE={"responseTime":{"p95":500}}' /scripts/profiles/ramp-up.js
```

| 환경변수 | 기본값 | 설명 |
| - | - | - |
| `SLA_OVERRIDE` | - | JSON 형식 커스텀 SLA. 기본 SLA를 오버라이드 |
| `SLA_TOLERANCE` | `0` | SLA 완화 비율 (%). 20이면 P95 300ms → 360ms |

**출력 파일:**
- `*_sla.json`: SLA 평가 결과 (자동화용)
- 마크다운 리포트 내 "SLA 평가 결과" 섹션

## 아키텍처

### API 구조 (NestJS)

```text
api/src/
├── config/           # 환경변수 기반 설정 (database.config.ts에서 풀 설정)
├── database/entities/  # TypeORM 엔티티 (users, products, orders, order_items, file_records)
├── scenarios/        # 7가지 테스트 시나리오 엔드포인트
├── metrics/          # 풀 상태 모니터링 (/api/metrics/pools)
└── health/           # 헬스체크 (/health)
```

### k6 구조

```text
k6/
├── lib/              # 공통 설정 및 헬퍼
│   ├── config.js     # 공통 설정, thresholds, 베이스라인 로드
│   ├── helpers.js    # 메트릭 수집, 단계별 분석
│   ├── baseline.js   # 베이스라인 로드, 비교, 동적 threshold 생성
│   └── sla.js        # SLA 정의, 평가, 리포트 생성
├── profiles/         # 테스트 프로파일
│   ├── baseline.js   # 베이스라인 수집 전용 (~6분, 100 VUs)
│   ├── ramp-up.js    # 점진적 부하 증가 (~7분, 최대 200 VUs)
│   ├── stress.js     # 한계점 찾기 (~22분, 최대 3000 VUs)
│   └── soak.js       # 장시간 안정성 (~34분, 500 VUs)
└── scenarios/        # 개별 시나리오 스크립트
```

### 핵심 튜닝 대상

1. DB 커넥션 풀 (`DB_POOL_SIZE`): 공식 = TPS × 평균쿼리시간(초)
2. libuv 스레드 풀 (`UV_THREADPOOL_SIZE`): 파일 I/O, crypto, bcrypt 등에 영향

## 주요 API 엔드포인트

| 엔드포인트 | 용도 |
|-----------|------|
| `/api/scenarios/simple-query?id={id}` | PK 조회 (5~10ms) |
| `/api/scenarios/complex-query?delay={ms}` | 3+ JOIN 쿼리 (100~200ms) |
| `/api/scenarios/cpu-intensive` | bcrypt + JSON (300~500ms) |
| `/api/scenarios/file-and-db` | 파일 I/O + DB (50~100ms) |
| `/api/scenarios/pool-exhaustion?holdTime={ms}` | 커넥션 고갈 시뮬레이션 |
| `/api/metrics/pools` | 풀 상태 메트릭 조회 |

## 환경변수 (.env)

```bash
# 커넥션 풀 튜닝
DB_POOL_SIZE=10              # 기본값, 부족하면 waitingRequests 증가
DB_POOL_ACQUIRE_TIMEOUT=10000

# libuv 스레드 풀 튜닝
UV_THREADPOOL_SIZE=4         # 기본값, 파일 I/O 병목 시 증가

# 부하 설정
BCRYPT_ROUNDS=12             # CPU 집약 작업 강도
```

## 병목 판단 기준

- `waitingRequests > 0` → DB 커넥션 풀 사이즈 부족
- 파일 I/O 응답 지연 → UV_THREADPOOL_SIZE 부족
- CPU 100% 근접 → 워커 수 또는 인스턴스 확장 필요

## Git 규칙

### 브랜치 규칙

- 브랜치 전략: GitHub Flow
- 브랜치 네이밍: `<타입>/<이슈번호>-<간단한-설명>`
  - 예: `feature/12-social-login`, `bugfix/45-login-validation`
- 브랜치 타입:
  - `feature`: 새 기능 추가
  - `bugfix`: 버그 수정
  - `hotfix`: 긴급 수정 (프로덕션 이슈)
  - `refactor`: 코드 리팩토링 (기능 변경 없음)
  - `docs`: 문서 작업

### 구현 절차

글로벌 작업 절차(4-12단계)를 따른다.

프로젝트 특화 규칙:

- 브랜치 네이밍: `<타입>/<이슈번호>-<간단한-설명>`
- 브랜치 생성 후 원격에 push: `git checkout -b <branch> && git push -u origin <branch>`
- 머지 전략: Squash Merge
- 머지 후: 브랜치 삭제 (원격/로컬)
