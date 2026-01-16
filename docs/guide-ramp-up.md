# Ramp-Up 테스트 실습 가이드

점진적으로 부하를 증가시키며 커넥션 풀과 스레드 풀 튜닝의 기초를 학습합니다.

---

## 프로파일 개요

### 목적

**점진적으로 부하를 증가**시키면서 시스템이 어떻게 반응하는지 관찰합니다.
각 단계에서 응답 시간, 에러율, 리소스 사용량이 어떻게 변하는지 확인합니다.

### 사용 시점

- 새 기능 배포 전 기본 성능 검증
- 커넥션 풀/스레드 풀 설정 변경 후 효과 확인
- 일상적인 성능 모니터링

### 테스트 구성

```text
┌─────────────────────────────────────────────────────────────────────┐
│  VUs                                                                │
│  200 ─────────────────────────────────────────────┐                 │
│                                                    │                │
│  100 ─────────────────────────┐                    │                │
│                                │                    │                │
│   50 ──────────────┐           │                    │                │
│                     │           │                    │                │
│    0 ───────────────┴───────────┴────────────────────┴──────────    │
│       0분    1분    2분    3분    4분    5분    6분    7분           │
└─────────────────────────────────────────────────────────────────────┘
```

### 단계별 의도

| 단계 | 시간 | VUs | 의도 |
|------|------|-----|------|
| **1. 워밍업** | 0~1분 | 0→50 | JIT 컴파일, 커넥션 풀 초기화. 콜드 스타트 영향 제거 |
| **2. 저부하** | 1~2분 | 50 유지 | 기준선(baseline) 측정. 이 값이 정상 상태 |
| **3. 증가** | 2~3분 | 50→100 | 부하 2배 증가 시 응답 시간이 선형으로 증가하는지 확인 |
| **4. 중부하** | 3~4분 | 100 유지 | 중간 부하에서 안정적으로 처리하는지 확인 |
| **5. 증가** | 4~5분 | 100→200 | 목표 부하에 도달. 커넥션 풀 대기 현상 발생 여부 확인 |
| **6. 피크** | 5~6분 | 200 유지 | 최대 부하에서 지속 처리 가능한지 확인 |
| **7. 쿨다운** | 6~7분 | 200→0 | 부하 제거 후 정상 복귀 확인. 리소스 해제 검증 |

### 성공 기준 (Thresholds)

```javascript
thresholds: {
  http_req_duration: ['p(95)<500'],  // 95%의 요청이 500ms 이내
  http_req_failed: ['rate<0.05'],    // 에러율 5% 미만
}
```

### 해석 가이드

| 관찰 지표 | 정상 | 주의 | 위험 |
|-----------|------|------|------|
| P95 응답 시간 | < 200ms | 200~500ms | > 500ms |
| 에러율 | 0% | < 1% | > 5% |
| waitingRequests | 0 | 1~10 | > 10 |
| CPU 사용률 | < 70% | 70~85% | > 85% |

---

## 사전 준비

### 환경 설정

```powershell
# 1. .env 파일 생성 (최초 1회)
copy .env.example .env

# 2. 환경 실행
docker-compose up -d

# 3. 헬스 체크 (API 준비 확인)
curl http://localhost:3000/health
```

### 실행 명령어

```powershell
# Docker로 Ramp-Up 테스트 실행
docker-compose --profile test run --rm k6

# 로컬 k6 사용 시
k6 run k6/profiles/ramp-up.js

# 특정 시나리오로 테스트
$env:K6_SCENARIO="complex-query"; docker-compose --profile test run --rm k6
```

---

## 실습 1: 커넥션 풀 부족 현상 관찰

### 실습 1 목적

**의도적으로 커넥션을 부족하게 설정**하여 병목 현상을 직접 관찰합니다.
메트릭에서 `waitingRequests`가 증가하고 응답 시간이 느려지는 것을 확인합니다.

### 실습 1 배경 지식

```text
필요 커넥션 수 = TPS × 평균 쿼리 시간(초)
```

100 VUs가 10ms 쿼리를 보내면 약 10개 커넥션이 필요합니다.
5개로 제한하면 부족 현상이 발생합니다.

### 실습 1 단계

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

**Step 2: 메트릭 관찰**

```powershell
curl http://localhost:3000/api/metrics/pools
```

관찰할 항목:

- `waitingRequests > 0` → 커넥션 대기 발생
- `acquireTime.avg` 증가 → 커넥션 획득에 시간 소요

**Step 3: 커넥션 20개로 증가 (충분하게)**

```powershell
$env:DB_POOL_SIZE=20; docker-compose up -d
docker-compose --profile test run --rm k6
```

**Step 4: 결과 비교**

| 풀 사이즈 | waitingRequests | acquireTime.avg | P95 응답시간 |
|-----------|-----------------|-----------------|--------------|
| 5개 (부족) | | | |
| 20개 (충분) | 0 | < 5ms | |

### 실습 1 핵심 관찰 포인트

- `waitingRequests` 값의 변화
- `acquireTime.avg`와 `acquireTime.p95`의 차이
- k6 결과의 `http_req_duration` 변화

### 실습 1 학습 포인트

- 커넥션이 부족하면 요청이 **대기 상태**가 됨
- 대기 시간이 응답 시간에 **직접 영향**
- 메트릭으로 병목을 **사전에 감지** 가능

---

## 실습 2: 쿼리 속도가 필요 커넥션 수에 미치는 영향

### 실습 2 목적

**같은 커넥션 풀 사이즈**에서 쿼리 속도에 따라 처리량이 어떻게 달라지는지 관찰합니다.
느린 쿼리가 왜 커넥션 풀을 빠르게 고갈시키는지 이해합니다.

### 실습 2 배경 지식

```text
필요 커넥션 = TPS × 쿼리 시간(초)

쿼리 10ms:  100 TPS × 0.01 = 1개
쿼리 100ms: 100 TPS × 0.1  = 10개
```

같은 TPS에서 쿼리가 10배 느리면 커넥션도 10배 필요합니다.

### 실습 2 단계

**Step 1: 빠른 쿼리 테스트 (10ms)**

```powershell
$env:DB_POOL_SIZE=10; docker-compose up -d

# simple-query 시나리오 (기본값)
docker-compose --profile test run --rm k6
```

**Step 2: 느린 쿼리 테스트 (100ms)**

```powershell
$env:DB_POOL_SIZE=10; docker-compose up -d

# complex-query 시나리오로 테스트
$env:K6_SCENARIO="complex-query"; docker-compose --profile test run --rm k6
```

**Step 3: 결과 비교**

| 쿼리 속도 | 필요 커넥션 | 설정값 10개로 충분? | waitingRequests |
|-----------|-------------|---------------------|-----------------|
| 10ms (빠름) | ~1개 | 충분 | |
| 100ms (느림) | ~10개 | **경계선** | |

### 실습 2 핵심 관찰 포인트

- 동일한 풀 사이즈에서 쿼리 속도에 따른 대기 현상 차이
- `http_req_duration`의 P50 vs P95 차이 (분산 증가)
- 쿼리 시간 증가와 커넥션 대기 시간의 상관관계

### 실습 2 학습 포인트

- **쿼리 최적화**가 풀 사이즈 증가보다 효과적일 수 있음
- 느린 쿼리 하나가 전체 시스템을 병목시킬 수 있음
- 모니터링으로 느린 쿼리를 찾아내는 것이 중요

---

## 실습 3: libuv 스레드 풀 튜닝

### 실습 3 목적

CPU 집약 작업(bcrypt)에서 `UV_THREADPOOL_SIZE`가 미치는 영향을 관찰합니다.
libuv 스레드 풀이 어떤 작업에 영향을 주는지 이해합니다.

### 실습 3 배경 지식

libuv 스레드 풀이 사용되는 작업:

- 파일 I/O (`fs` 모듈)
- DNS 조회
- `crypto` 일부 함수
- `bcrypt` 같은 네이티브 애드온

기본값 4개는 대부분 충분하지만, 위 작업이 동시에 많이 발생하면 병목이 됩니다.

### 실습 3 단계

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
|--------------------|------------------|----------------|
| 4 | | |
| 16 | | |

### 실습 3 핵심 관찰 포인트

- bcrypt 해싱 시간 변화
- `docker stats`로 CPU 사용률 확인
- 스레드 풀 증가의 한계점 (128 이상은 효과 미미)

### 실습 3 학습 포인트

- libuv 스레드 풀은 특정 I/O 작업에만 영향
- CPU 집약 작업에서는 스레드 풀 증가 효과가 크지만 한계 존재
- 네트워크 I/O(HTTP 요청, DB 쿼리)는 libuv 스레드 풀과 무관

---

## 실습 4: 병목 지점 진단하기

### 실습 4 목적

메트릭을 분석하여 현재 병목이 **어디인지** 판단하는 방법을 배웁니다.

### 실습 4 배경 지식

성능 문제가 발생했을 때, 원인이 다양할 수 있습니다:

- DB 커넥션 풀 부족
- libuv 스레드 풀 부족
- CPU 리소스 부족
- 네트워크 지연

메트릭을 체계적으로 확인하여 병목을 정확히 진단해야 합니다.

### 병목 진단 체크리스트

| 증상 | 가능한 병목 | 확인 방법 | 해결 |
|------|-------------|-----------|------|
| `waitingRequests > 0` | DB 커넥션 풀 부족 | `/api/metrics/pools` | `DB_POOL_SIZE` 증가 |
| `acquireTime.p95 > 100ms` | DB 커넥션 풀 부족 | `/api/metrics/pools` | `DB_POOL_SIZE` 증가 |
| bcrypt 시간 증가 | libuv 스레드 풀 부족 | 응답 데이터 | `UV_THREADPOOL_SIZE` 증가 |
| CPU 100% | CPU 리소스 부족 | `docker stats` | bcrypt rounds 감소 또는 스케일 아웃 |

### 실습 4 단계

**Step 1: 모니터링 환경 설정**

별도 터미널에서 실시간 모니터링 실행:

```powershell
# PowerShell - 실시간 메트릭 확인
while ($true) {
    Clear-Host
    curl -s http://localhost:3000/api/metrics/pools | ConvertFrom-Json | ConvertTo-Json
    Start-Sleep 2
}
```

**Step 2: 의도적으로 병목 만들기**

```powershell
# DB 커넥션 풀 병목
$env:DB_POOL_SIZE=3; $env:UV_THREADPOOL_SIZE=16; docker-compose up -d
$env:K6_SCENARIO="simple-query"; docker-compose --profile test run --rm k6
```

**Step 3: 메트릭으로 병목 확인**

```powershell
# 다른 터미널에서
curl http://localhost:3000/api/metrics/pools
docker stats
```

**Step 4: 병목 해소 후 재테스트**

```powershell
$env:DB_POOL_SIZE=30; docker-compose up -d
docker-compose --profile test run --rm k6
```

### 실습 4 핵심 관찰 포인트

- 어떤 메트릭이 먼저 이상 징후를 보이는지
- 병목 해소 후 성능 개선 정도
- 한 병목이 해소되면 다른 병목이 드러나는 현상

### 실습 4 학습 포인트

- 병목은 하나씩 해결해야 함 (병목 이동 현상)
- 메트릭 기반 진단이 추측보다 정확함
- 실시간 모니터링의 중요성

---

## 실습 5: 적정 커넥션 풀 사이즈 찾기

### 실습 5 목적

주어진 부하에서 **최적의 커넥션 풀 사이즈**를 찾는 방법을 연습합니다.

### 실습 5 배경 지식

커넥션 풀 사이즈를 결정하는 공식:

```text
필요 커넥션 = TPS × 쿼리 시간(초)
최종 권장값 = 필요 커넥션 × 1.2 (20% 여유)
```

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

### 실습 5 단계

**Step 1: 부족한 값으로 시작**

```powershell
$env:DB_POOL_SIZE=10; docker-compose up -d
docker-compose --profile test run --rm k6
```

메트릭 기록:

| 설정 | waitingRequests | P95 응답 시간 | 에러율 |
|------|-----------------|---------------|--------|
| 10 | | | |

**Step 2: 점진적으로 증가**

```powershell
$env:DB_POOL_SIZE=20; docker-compose up -d
docker-compose --profile test run --rm k6
```

**Step 3: 충분한 값 확인**

```powershell
$env:DB_POOL_SIZE=30; docker-compose up -d
docker-compose --profile test run --rm k6
```

**Step 4: 결과 비교**

| 풀 사이즈 | waitingRequests | idleConnections | P95 응답 시간 |
|-----------|-----------------|-----------------|---------------|
| 10 (부족) | | | |
| 20 (적정) | | | |
| 30 (여유) | | | |

### 권장 설정 가이드

| 환경 | TPS | 쿼리 시간 | 권장 풀 사이즈 |
|------|-----|-----------|----------------|
| 개발 | 10 | 10ms | 5 |
| 스테이징 | 100 | 30ms | 5~10 |
| 운영 (소규모) | 500 | 20ms | 15~20 |
| 운영 (대규모) | 2000 | 50ms | 100~150 |

### 실습 5 핵심 관찰 포인트

- `waitingRequests`가 0이 되는 최소 풀 사이즈
- `idleConnections`가 지나치게 많지 않은지
- 에러율과 응답 시간의 안정화 지점

### 실습 5 학습 포인트

- 무조건 크게 설정하는 것은 리소스 낭비
- 부하에 맞는 적정값을 찾는 것이 중요
- 실제 운영에서는 여유분(20~30%)을 추가

---

## 트러블슈팅

### 문제: waitingRequests가 계속 증가

**원인**: 커넥션 풀 사이즈 부족

```powershell
# 풀 사이즈 증가
$env:DB_POOL_SIZE=30; docker-compose up -d
```

### 문제: acquireTime은 낮은데 응답이 느림

**원인**: 쿼리 자체가 느리거나 CPU 병목

```powershell
# CPU 확인
docker stats

# libuv 스레드 풀 확인 (cpu-intensive 시나리오인 경우)
$env:UV_THREADPOOL_SIZE=16; docker-compose up -d
```

### 문제: 테스트 시작 시 에러 급증

**원인**: 콜드 스타트, 커넥션 풀 미초기화

```powershell
# 헬스 체크로 워밍업
curl http://localhost:3000/health
curl http://localhost:3000/api/scenarios/simple-query?id=1
```

---

## 다음 단계

Ramp-Up 테스트로 기본 튜닝을 완료했다면, 다음 프로파일로 진행하세요:

1. **[Stress 테스트](guide-stress.md)** - 시스템 한계점 찾기
   - 최대 처리량(TPS) 확인
   - 장애 발생 시점과 양상 파악

2. **[Soak 테스트](guide-soak.md)** - 장시간 안정성 검증
   - 메모리 누수 탐지
   - 커넥션 풀 안정성 확인
