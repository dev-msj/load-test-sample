# Soak 테스트 실습 가이드

장시간 일정 부하를 유지하며 시간에 따른 성능 저하와 리소스 누수를 탐지합니다.

---

## 프로파일 개요

### 목적

**일정 부하를 장시간 유지**하여 시간이 지남에 따라 발생하는 문제를 찾습니다.
메모리 누수, 커넥션 풀 고갈, 파일 핸들 누수 등을 확인합니다.

### 사용 시점

- 운영 환경 배포 전 최종 검증
- 메모리 누수 의심 시
- 장시간 운영 안정성 확인
- 리소스 누적 고갈 현상 검증

### 테스트 구성

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│  VUs                                                                            │
│                                                                                 │
│  500 ─────┬──────────────────────────────────────────────────────────┐          │
│           │                                                           │          │
│           │              30분 동안 일정 부하 유지                       │          │
│           │                                                           │          │
│     0 ────┴───────────────────────────────────────────────────────────┴────     │
│        0  2분                                                      32분 34분    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 단계별 의도

| 단계 | 시간 | VUs | 의도 |
|------|------|-----|------|
| **1. 워밍업** | 0~2분 | 0→500 | 시스템 안정화. 커넥션 풀 완전 초기화 |
| **2. 지속 부하** | 2~32분 | 500 유지 | **핵심 구간**: 30분간 일정 부하 유지하며 성능 저하 관찰 |
| **3. 쿨다운** | 32~34분 | 500→0 | 부하 제거 후 리소스 정상 해제 확인 |

### 성공 기준 (Thresholds)

```javascript
thresholds: {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],  // 엄격한 응답 시간
  http_req_failed: ['rate<0.01'],                  // 1% 미만 에러율
}
```

> **핵심**: Soak 테스트는 **시간에 따른 변화**를 관찰합니다.
> 시작과 끝의 메트릭을 비교해야 합니다.

### 관찰 포인트

| 시점 | 확인 항목 | 정상 | 문제 징후 |
|------|-----------|------|-----------|
| **시작 5분** | 기준값 측정 | P95: 100ms, 메모리: 200MB | - |
| **15분** | 중간 점검 | 기준값과 동일 | 응답 시간/메모리 증가 시작 |
| **30분** | 최종 확인 | 기준값 대비 10% 이내 | 기준값 대비 50% 이상 증가 |

### 시간에 따른 문제 유형

| 시간 경과 | 증상 | 가능한 원인 | 해결 방법 |
|-----------|------|-------------|-----------|
| 10~15분 | 응답 시간 서서히 증가 | 커넥션 풀 단편화 | 커넥션 재사용 로직 점검 |
| 20분+ | 메모리 지속 증가 | 메모리 누수 | 힙 덤프 분석, 이벤트 리스너 점검 |
| 30분+ | 간헐적 타임아웃 | 리소스 고갈 | 파일 핸들/소켓 누수 확인 |
| 전체 | 에러율 점진 증가 | DB 커넥션 누수 | 트랜잭션 미완료 확인 |

---

## 사전 준비

### 환경 설정

```powershell
# 1. 안정적인 설정으로 시작 (Ramp-Up/Stress에서 확인된 값)
$env:DB_POOL_SIZE=30; $env:UV_THREADPOOL_SIZE=16; docker-compose up -d

# 2. 헬스 체크
curl http://localhost:3000/health

# 3. 초기 메트릭 확인
curl http://localhost:3000/api/metrics/pools
```

### 실행 명령어

```powershell
# 로컬 k6 사용 (필수 - 약 34분 소요)
k6 run k6/profiles/soak.js

# 백그라운드 실행 (Windows)
Start-Process k6 -ArgumentList "run k6/profiles/soak.js" -NoNewWindow

# 결과 파일 위치
cat ./soak-summary.json
```

> **주의**: Soak 테스트는 약 34분이 소요됩니다.
> 충분한 시스템 리소스가 확보된 환경에서 실행하세요.

---

## 실습 1: 메모리 누수 탐지

### 실습 1 목적

장시간 부하 중 **힙 메모리와 RSS 메모리의 증가 추이**를 관찰합니다.
메모리 누수가 있는지, GC가 정상 작동하는지 확인합니다.

### 실습 1 배경 지식

**메모리 누수 징후**:

- 힙 메모리가 GC 후에도 기준선으로 돌아오지 않음
- RSS 메모리가 지속적으로 증가
- 시간이 지남에 따라 GC 빈도 증가

```text
정상적인 메모리 패턴:
  메모리
    │    ┌─┐  ┌─┐  ┌─┐  ┌─┐
    │   ┌┘ └┐┌┘ └┐┌┘ └┐┌┘ └┐  ← GC마다 기준선으로 복귀
    │───┴───┴┴───┴┴───┴┴───┴──▶ 시간

메모리 누수 패턴:
  메모리
    │              ┌─┐
    │         ┌─┐ ┌┘ └┐  ← 기준선이 점점 상승
    │    ┌─┐ ┌┘ └┐┘
    │───┌┘ └┐┘          ──▶ 시간
```

### 실습 1 단계

**Step 1: 초기 메모리 기준값 측정**

```powershell
# 환경 시작
$env:DB_POOL_SIZE=30; docker-compose up -d

# 초기 메모리 확인
curl http://localhost:3000/api/metrics/pools
```

초기값 기록:

| 지표 | 초기값 |
|------|--------|
| heapUsed | MB |
| heapTotal | MB |
| rss | MB |

**Step 2: Soak 테스트 실행과 동시에 모니터링**

터미널 1 - Soak 테스트:

```powershell
k6 run k6/profiles/soak.js
```

터미널 2 - 메모리 모니터링 (5분마다 기록):

```powershell
while ($true) {
    $timestamp = Get-Date -Format "HH:mm:ss"
    $metrics = (curl -s http://localhost:3000/api/metrics/pools) | ConvertFrom-Json
    $heap = [math]::Round($metrics.process.memory.heapUsed / 1MB, 2)
    $rss = [math]::Round($metrics.process.memory.rss / 1MB, 2)
    Write-Host "$timestamp - Heap: ${heap}MB, RSS: ${rss}MB"
    Start-Sleep 300  # 5분마다
}
```

**Step 3: 메모리 추이 기록**

| 시간 | heapUsed (MB) | heapTotal (MB) | rss (MB) | 비고 |
|------|---------------|----------------|----------|------|
| 0분 (시작) | | | | 기준값 |
| 5분 | | | | |
| 10분 | | | | |
| 15분 | | | | |
| 20분 | | | | |
| 25분 | | | | |
| 30분 | | | | |
| 34분 (종료) | | | | |

**Step 4: 결과 분석**

```text
증가율 = (종료 시 heapUsed - 시작 시 heapUsed) / 시작 시 heapUsed × 100%
```

### 실습 1 핵심 관찰 포인트

- **힙 메모리 증가율**: 30분간 50% 이상 증가 시 누수 의심
- **GC 후 기준선**: GC 직후에도 메모리가 높게 유지되는지
- **RSS vs Heap 차이**: RSS만 증가하면 네이티브 메모리 누수

### 실습 1 학습 포인트

- 메모리 누수는 장시간 테스트에서만 발견 가능
- GC가 있어도 참조가 남아있으면 메모리 해제 안됨
- 이벤트 리스너, 클로저, 전역 변수가 주요 누수 원인

---

## 실습 2: 커넥션 풀 안정성 검증

### 실습 2 목적

장시간 부하 중 **DB 커넥션 풀이 안정적으로 유지되는지** 확인합니다.
커넥션 누수나 풀 고갈 현상이 발생하는지 관찰합니다.

### 실습 2 배경 지식

**커넥션 풀 문제 징후**:

- `active + idle` 합계가 `poolSize`를 초과
- `idleConnections`가 0인 상태 지속
- MySQL `Threads_connected`가 계속 증가

```text
정상적인 커넥션 풀:
  active + idle = poolSize (일정)

커넥션 누수:
  active만 증가, idle은 0으로 유지
  → 커넥션이 반환되지 않음
```

### 실습 2 단계

**Step 1: 초기 커넥션 상태 확인**

```powershell
$env:DB_POOL_SIZE=30; docker-compose up -d

# API 커넥션 풀 상태
curl http://localhost:3000/api/metrics/pools

# MySQL 커넥션 상태
docker exec load-test-sample-mysql-1 mysql -uroot -ppassword -e "SHOW STATUS LIKE 'Threads_connected'"
```

**Step 2: Soak 테스트와 커넥션 모니터링**

터미널 1 - Soak 테스트:

```powershell
k6 run k6/profiles/soak.js
```

터미널 2 - 커넥션 모니터링:

```powershell
while ($true) {
    $timestamp = Get-Date -Format "HH:mm:ss"

    # API 풀 상태
    $metrics = (curl -s http://localhost:3000/api/metrics/pools) | ConvertFrom-Json
    $active = $metrics.database.activeConnections
    $idle = $metrics.database.idleConnections
    $waiting = $metrics.database.waitingRequests

    # MySQL 상태
    $mysql = docker exec load-test-sample-mysql-1 mysql -uroot -ppassword -N -e "SHOW STATUS LIKE 'Threads_connected'" 2>$null
    $threads = ($mysql -split '\t')[1]

    Write-Host "$timestamp - Active: $active, Idle: $idle, Waiting: $waiting, MySQL Threads: $threads"
    Start-Sleep 60  # 1분마다
}
```

**Step 3: 커넥션 추이 기록**

| 시간 | activeConnections | idleConnections | waitingRequests | MySQL Threads |
|------|-------------------|-----------------|-----------------|---------------|
| 0분 | | | | |
| 5분 | | | | |
| 10분 | | | | |
| 15분 | | | | |
| 20분 | | | | |
| 25분 | | | | |
| 30분 | | | | |

**Step 4: 테스트 종료 후 정리 확인**

```powershell
# 테스트 종료 1분 후
curl http://localhost:3000/api/metrics/pools

# 예상: activeConnections가 0 또는 최소값, idleConnections가 풀 사이즈
```

### 실습 2 핵심 관찰 포인트

- **active + idle 합계**: 풀 사이즈와 일치하는지
- **waitingRequests 추이**: 시간이 지나도 0을 유지하는지
- **MySQL Threads_connected**: API 풀 사이즈와 비슷한 값 유지하는지

### 실습 2 학습 포인트

- 커넥션 누수는 트랜잭션 미완료가 주 원인
- 에러 처리 시 커넥션 반환 누락 주의
- 커넥션 풀 사이즈는 MySQL max_connections 이하로

---

## 실습 3: 응답 시간 저하(Degradation) 추적

### 실습 3 목적

시간이 지남에 따라 **응답 시간이 점진적으로 느려지는지** 추적합니다.
성능 저하(Degradation)의 원인을 파악합니다.

### 실습 3 배경 지식

**성능 저하 원인**:

- 메모리 부족으로 인한 GC 빈도 증가
- 커넥션 풀 단편화
- 캐시 메모리 고갈
- 디스크 I/O 증가 (스왑, 로그 파일)

```text
정상: 응답 시간 일정
  P95
   │─────────────────────────────▶ 시간

저하: 응답 시간 점진 증가
  P95
   │                      ╱╱╱
   │               ╱╱╱╱╱╱╱
   │─────────╱╱╱╱╱
   │─────────────────────────────▶ 시간
```

### 실습 3 단계

**Step 1: 초기 응답 시간 기준값 측정**

```powershell
$env:DB_POOL_SIZE=30; docker-compose up -d

# 짧은 부하 테스트로 기준값 측정
k6 run k6/scenarios/simple-query.js --env VUS=100 --env DURATION=60s
```

기준값 기록:

| 지표 | 초기값 |
|------|--------|
| P50 | ms |
| P95 | ms |
| P99 | ms |

**Step 2: Soak 테스트 실행**

```powershell
k6 run k6/profiles/soak.js
```

k6 실행 중 콘솔에 출력되는 실시간 응답 시간 관찰

**Step 3: 구간별 응답 시간 기록**

Soak 테스트 결과 또는 실시간 모니터링에서 기록:

| 시간 구간 | P50 (ms) | P95 (ms) | P99 (ms) | 에러율 |
|-----------|----------|----------|----------|--------|
| 0~5분 | | | | |
| 5~10분 | | | | |
| 10~15분 | | | | |
| 15~20분 | | | | |
| 20~25분 | | | | |
| 25~30분 | | | | |

**Step 4: 저하율 분석**

```text
저하율 = (30분 시점 P95 - 5분 시점 P95) / 5분 시점 P95 × 100%
```

- **10% 이내**: 정상 (허용 범위)
- **10~30%**: 주의 (원인 조사 필요)
- **30% 이상**: 위험 (성능 문제 존재)

### 실습 3 핵심 관찰 포인트

- **P50 vs P95 차이 증가**: 일부 요청만 느려지는 패턴
- **저하 시작 시점**: 언제부터 저하가 시작되는지
- **저하 패턴**: 선형 증가 vs 단계적 증가

### 실습 3 학습 포인트

- 응답 시간 저하는 리소스 고갈의 신호
- P50은 정상인데 P95만 증가하면 간헐적 병목
- 저하 시작 시점의 리소스 상태가 원인 파악에 중요

---

## 실습 4: 리소스 고갈 시뮬레이션

### 실습 4 목적

파일 핸들, 소켓 등 **OS 레벨 리소스가 누적되는지** 관찰합니다.
장시간 운영 시 발생할 수 있는 리소스 고갈을 미리 탐지합니다.

### 실습 4 배경 지식

**모니터링해야 할 OS 리소스**:

- **파일 핸들 (File Descriptors)**: 열린 파일, 소켓 수
- **네트워크 소켓**: TIME_WAIT 상태 누적
- **임시 파일**: /tmp 디렉토리 사용량
- **libuv handles**: Node.js 내부 핸들

```text
리소스 고갈 증상:
- EMFILE: Too many open files
- ENOMEM: Out of memory
- ETIMEDOUT: 소켓 고갈로 연결 불가
```

### 실습 4 단계

**Step 1: 초기 리소스 상태 확인**

```powershell
$env:DB_POOL_SIZE=30; docker-compose up -d

# libuv 핸들 상태
$metrics = (curl -s http://localhost:3000/api/metrics/pools) | ConvertFrom-Json
Write-Host "Active Handles: $($metrics.libuv.activeHandles)"
Write-Host "Active Requests: $($metrics.libuv.activeRequests)"

# 컨테이너 프로세스 상태
docker exec load-test-sample-api-1 sh -c "ls /proc/1/fd | wc -l" 2>$null
```

**Step 2: file-and-db 시나리오로 파일 I/O 부하**

파일 I/O가 포함된 시나리오로 테스트하여 파일 핸들 누수 확인:

```powershell
# file-and-db 시나리오 사용
k6 run k6/profiles/soak.js --env SCENARIO=file-and-db
```

**Step 3: 리소스 모니터링**

```powershell
while ($true) {
    $timestamp = Get-Date -Format "HH:mm:ss"

    # libuv 핸들
    $metrics = (curl -s http://localhost:3000/api/metrics/pools) | ConvertFrom-Json
    $handles = $metrics.libuv.activeHandles
    $requests = $metrics.libuv.activeRequests

    # 파일 디스크립터 (리눅스 컨테이너)
    $fdCount = docker exec load-test-sample-api-1 sh -c "ls /proc/1/fd 2>/dev/null | wc -l"

    Write-Host "$timestamp - Handles: $handles, Requests: $requests, FDs: $fdCount"
    Start-Sleep 60
}
```

**Step 4: 리소스 추이 기록**

| 시간 | activeHandles | activeRequests | FD Count | 비고 |
|------|---------------|----------------|----------|------|
| 0분 | | | | 기준값 |
| 10분 | | | | |
| 20분 | | | | |
| 30분 | | | | |
| 종료 후 | | | | 정리 확인 |

**Step 5: 테스트 종료 후 정리 확인**

```powershell
# 테스트 종료 2분 후
$metrics = (curl -s http://localhost:3000/api/metrics/pools) | ConvertFrom-Json
Write-Host "Active Handles: $($metrics.libuv.activeHandles)"

# 예상: 초기값과 비슷한 수준으로 복귀
```

### 실습 4 핵심 관찰 포인트

- **activeHandles 증가율**: 시간에 따라 계속 증가하면 핸들 누수
- **테스트 종료 후 값**: 초기값으로 복귀해야 정상
- **FD Count**: 컨테이너의 파일 디스크립터 수

### 실습 4 학습 포인트

- 파일 핸들 누수는 장시간 운영에서 심각한 문제
- 이벤트 리스너, 스트림 미종료가 주요 원인
- libuv handles 모니터링으로 조기 탐지 가능

---

## 트러블슈팅

### 문제: 테스트 중간에 메모리 부족

**원인**: 힙 메모리 제한 도달

```powershell
# Node.js 메모리 제한 확인 (docker-compose.yml)
# NODE_OPTIONS=--max-old-space-size=1024

# 필요시 제한 증가
docker-compose down
# docker-compose.yml에서 메모리 설정 변경 후
docker-compose up -d
```

### 문제: MySQL 커넥션 거부

**원인**: max_connections 도달

```powershell
# MySQL 설정 확인
docker exec load-test-sample-mysql-1 mysql -uroot -ppassword -e "SHOW VARIABLES LIKE 'max_connections'"

# 필요시 증가
docker exec load-test-sample-mysql-1 mysql -uroot -ppassword -e "SET GLOBAL max_connections=200"
```

### 문제: 테스트가 너무 오래 걸림

**원인**: 34분은 기본 설정

```powershell
# 더 짧은 시간으로 테스트 (10분 버전)
k6 run k6/profiles/soak.js --env SOAK_DURATION=10m
```

---

## 다음 단계

Soak 테스트로 장시간 안정성을 검증했다면:

1. **운영 배포 준비 완료**
   - Ramp-Up → Stress → Soak 모두 통과 시

2. **문제 발견 시 수정 후 재테스트**
   - 메모리 누수 발견 → 코드 수정 → Soak 재실행
   - 성능 저하 발견 → 원인 분석 → 수정 → 재실행

3. **[Ramp-Up 테스트](guide-ramp-up.md)로 돌아가기**
   - 수정사항 반영 후 기본 성능 재확인

4. **[Stress 테스트](guide-stress.md)로 돌아가기**
   - 수정 후 한계점 변화 확인
