/**
 * Ramp-Up 프로파일: 점진적 부하 증가
 * 100 → 500 → 1000 → 2000 TPS
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, endpoints, randomUserId, defaultThresholds } from '../lib/config.js';
import {
  jsonHeaders,
  errorRate,
  getRampUpLevel,
  checkResponseWithLevel,
  collectMetricsWithLevel,
} from '../lib/helpers.js';

export const options = {
  stages: [
    // 워밍업: 50 VUs
    { duration: '30s', target: 50 },
    { duration: '1m', target: 50 },

    // 100 VUs로 증가
    { duration: '30s', target: 100 },
    { duration: '2m', target: 100 },

    // 200 VUs로 증가 (피크)
    { duration: '30s', target: 200 },
    { duration: '2m', target: 200 },

    // 쿨다운
    { duration: '30s', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  const scenario = __ENV.SCENARIO || 'simple-query';
  const currentVUs = __VU || 1;
  const level = getRampUpLevel(currentVUs);
  let response;

  switch (scenario) {
    case 'simple-query':
      response = http.get(
        `${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`
      );
      break;

    case 'complex-query':
      response = http.get(
        `${BASE_URL}${endpoints.complexQuery}?delay=100`
      );
      break;

    case 'cpu-intensive':
      response = http.post(
        `${BASE_URL}${endpoints.cpuIntensive}`,
        JSON.stringify({ password: 'testpassword123', jsonSize: 5000 }),
        { headers: jsonHeaders }
      );
      break;

    case 'file-and-db':
      response = http.post(
        `${BASE_URL}${endpoints.fileAndDb}`,
        JSON.stringify({ fileSize: 1024 }),
        { headers: jsonHeaders }
      );
      break;

    case 'external-api':
      response = http.get(
        `${BASE_URL}${endpoints.externalApi}?delay=200`
      );
      break;

    case 'mixed':
      response = http.post(
        `${BASE_URL}${endpoints.mixed}`,
        JSON.stringify({}),
        { headers: jsonHeaders }
      );
      break;

    default:
      response = http.get(
        `${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`
      );
  }

  // VUs 레벨별 메트릭 기록
  checkResponseWithLevel(response, scenario, level);

  // 10% 확률로 메트릭 수집
  if (Math.random() < 0.1) {
    collectMetricsWithLevel(level);
  }

  sleep(0.1);
}

export function handleSummary(data) {
  const scenario = __ENV.SCENARIO || 'simple-query';
  const poolSize = __ENV.DB_POOL_SIZE || '10';
  const threadSize = __ENV.UV_THREADPOOL_SIZE || '4';
  const filename = `${scenario}_conn-${poolSize}_thread-${threadSize}`;

  // 메트릭 추출 헬퍼 함수
  const m = (name, field = 'avg') => {
    const metric = data.metrics[name];
    if (!metric) return 'N/A';
    const value = metric[field] !== undefined ? metric[field] : metric.values?.[field];
    return typeof value === 'number' ? value.toFixed(2) : 'N/A';
  };

  const mRaw = (name, field = 'avg') => {
    const metric = data.metrics[name];
    if (!metric) return 0;
    return metric[field] !== undefined ? metric[field] : metric.values?.[field] || 0;
  };

  // 전체 지표
  const waitingAvg = mRaw('db_waiting_requests', 'avg');
  const waitingMax = mRaw('db_waiting_requests', 'max');
  const responseP95 = mRaw('http_req_duration', 'p(95)');
  const cpuAvg = mRaw('process_cpu_percent', 'avg');
  const heapPercent = mRaw('process_memory_heap_percent', 'avg');

  // ============================================================
  // VUs 레벨별 성능 추이 분석
  // ============================================================
  const levels = [
    { name: 'level50', label: '50 VUs', vus: 50 },
    { name: 'level100', label: '100 VUs', vus: 100 },
    { name: 'level200', label: '200 VUs', vus: 200 },
  ];

  const levelData = levels.map(level => {
    const responseTime = mRaw(`level_${level.vus}_response_time`, 'avg');
    const responseP95Level = mRaw(`level_${level.vus}_response_time`, 'p(95)');
    const errRate = mRaw(`level_${level.vus}_error_rate`, 'rate') * 100;
    const waiting = mRaw(`level_${level.vus}_waiting_requests`, 'avg');
    return {
      ...level,
      responseTime,
      responseP95: responseP95Level,
      errorRate: errRate,
      waitingRequests: waiting,
      hasData: responseTime > 0,
    };
  });

  // 확장성 분석: 부하 증가에 따른 응답 시간 변화
  let scalabilityAnalysis = '';
  const level50 = levelData.find(l => l.name === 'level50');
  const level100 = levelData.find(l => l.name === 'level100');
  const level200 = levelData.find(l => l.name === 'level200');

  if (level50?.hasData && level100?.hasData) {
    const increase50to100 = level50.responseTime > 0
      ? ((level100.responseTime - level50.responseTime) / level50.responseTime) * 100
      : 0;

    if (increase50to100 < 20) {
      scalabilityAnalysis += `✅ **50→100 VUs**: 응답 시간 ${increase50to100.toFixed(1)}% 증가 (선형 확장)\n`;
    } else if (increase50to100 < 50) {
      scalabilityAnalysis += `🔶 **50→100 VUs**: 응답 시간 ${increase50to100.toFixed(1)}% 증가 (약간의 부하 영향)\n`;
    } else {
      scalabilityAnalysis += `⚠️ **50→100 VUs**: 응답 시간 ${increase50to100.toFixed(1)}% 증가 (병목 발생 가능)\n`;
    }
  }

  if (level100?.hasData && level200?.hasData) {
    const increase100to200 = level100.responseTime > 0
      ? ((level200.responseTime - level100.responseTime) / level100.responseTime) * 100
      : 0;

    if (increase100to200 < 30) {
      scalabilityAnalysis += `✅ **100→200 VUs**: 응답 시간 ${increase100to200.toFixed(1)}% 증가 (양호한 확장성)\n`;
    } else if (increase100to200 < 100) {
      scalabilityAnalysis += `⚠️ **100→200 VUs**: 응답 시간 ${increase100to200.toFixed(1)}% 증가 (리소스 압박)\n`;
    } else {
      scalabilityAnalysis += `🔴 **100→200 VUs**: 응답 시간 ${increase100to200.toFixed(1)}% 증가 (심각한 병목)\n`;
    }
  }

  // 커넥션 풀 대기 추이
  if (level50?.hasData && level200?.hasData) {
    if (level200.waitingRequests > 10 && level50.waitingRequests < 5) {
      scalabilityAnalysis += `⚠️ **커넥션 풀 병목**: 50 VUs(${level50.waitingRequests.toFixed(1)}개) → 200 VUs(${level200.waitingRequests.toFixed(1)}개) 대기 증가\n`;
    } else if (level200.waitingRequests <= 5) {
      scalabilityAnalysis += `✅ **커넥션 풀 여유**: 200 VUs에서도 대기 요청 ${level200.waitingRequests.toFixed(1)}개\n`;
    }
  }

  // 병목 분석
  let bottleneckAnalysis = '';
  let recommendations = [];

  if (waitingAvg > 20) {
    bottleneckAnalysis += '⚠️ **커넥션 풀 병목 감지**: 평균 대기 요청이 ' + waitingAvg.toFixed(1) + '개입니다.\n';
    recommendations.push('DB_POOL_SIZE를 현재 값(' + poolSize + ')보다 늘려보세요.');
  } else if (waitingAvg > 5) {
    bottleneckAnalysis += '🔶 **경미한 커넥션 대기**: 평균 대기 요청이 ' + waitingAvg.toFixed(1) + '개입니다.\n';
    recommendations.push('부하가 더 높아지면 커넥션 풀 증가를 고려하세요.');
  } else {
    bottleneckAnalysis += '✅ **커넥션 풀 여유**: 대기 요청이 거의 없습니다.\n';
  }

  if (cpuAvg > 80) {
    bottleneckAnalysis += '⚠️ **높은 CPU 사용률**: 평균 ' + cpuAvg.toFixed(1) + '%입니다.\n';
    if (scenario === 'cpu-intensive') {
      recommendations.push('UV_THREADPOOL_SIZE를 늘리거나 BCRYPT_ROUNDS를 낮춰보세요.');
    }
  } else {
    bottleneckAnalysis += '✅ **CPU 여유**: 평균 ' + cpuAvg.toFixed(1) + '%입니다.\n';
  }

  if (heapPercent > 85) {
    bottleneckAnalysis += '⚠️ **메모리 압박**: 힙 사용률이 ' + heapPercent.toFixed(1) + '%입니다.\n';
    recommendations.push('메모리 누수를 점검하거나 컨테이너 메모리를 늘리세요.');
  } else {
    bottleneckAnalysis += '✅ **메모리 여유**: 힙 사용률이 ' + heapPercent.toFixed(1) + '%입니다.\n';
  }

  if (responseP95 > 500) {
    bottleneckAnalysis += '⚠️ **응답 지연**: P95 응답시간이 ' + responseP95.toFixed(0) + 'ms입니다.\n';
  } else if (responseP95 > 200) {
    bottleneckAnalysis += '🔶 **응답 시간 주의**: P95가 ' + responseP95.toFixed(0) + 'ms입니다.\n';
  } else {
    bottleneckAnalysis += '✅ **빠른 응답**: P95가 ' + responseP95.toFixed(0) + 'ms입니다.\n';
  }

  if (recommendations.length === 0) {
    recommendations.push('현재 설정이 적절합니다. 부하를 더 높여 한계점을 찾아보세요.');
  }

  // VUs별 성능 추이 테이블 생성
  const levelTableRows = levelData
    .filter(l => l.hasData)
    .map(l => {
      const status = l.errorRate > 1 ? '🔴' : l.waitingRequests > 10 ? '⚠️' : '✅';
      return `| ${l.label} | ${l.responseTime.toFixed(0)}ms | ${l.responseP95.toFixed(0)}ms | ${l.waitingRequests.toFixed(1)}개 | ${l.errorRate.toFixed(2)}% | ${status} |`;
    })
    .join('\n');

  // 마크다운 보고서 생성
  const report = `# 부하 테스트 분석 보고서

## 📋 테스트 개요

| 항목 | 값 |
|------|-----|
| **테스트 시나리오** | ${scenario} |
| **커넥션 풀 크기** | ${poolSize}개 |
| **스레드 풀 크기** | ${threadSize}개 |
| **테스트 시간** | 약 7분 (ramp-up 프로파일) |
| **최대 동시 사용자** | 200 VUs |

---

## 📈 VUs 레벨별 성능 추이

> 부하 증가에 따른 성능 변화를 추적하여 시스템의 확장성을 평가합니다.

| VUs 레벨 | 평균 응답 | P95 응답 | 대기 요청 | 에러율 | 상태 |
|----------|----------|----------|-----------|--------|------|
${levelTableRows || '| (데이터 없음) | - | - | - | - | - |'}

### 확장성 분석

${scalabilityAnalysis || '✅ 데이터 수집 중... 테스트 완료 후 분석 결과가 표시됩니다.'}

---

## 📊 전체 성능 지표

### 처리량 (Throughput)

> 서버가 단위 시간당 처리한 요청 수입니다. 높을수록 좋습니다.

| 지표 | 값 | 설명 |
|------|-----|------|
| **총 요청 수** | ${m('http_reqs', 'count')} | 테스트 동안 처리한 전체 HTTP 요청 |
| **초당 요청 수 (RPS)** | ${m('http_reqs', 'rate')} req/sec | 평균 처리량 |
| **총 반복 수** | ${m('iterations', 'count')} | 완료된 테스트 시나리오 반복 |

### 응답 시간 (Response Time)

> 요청을 보내고 응답을 받기까지 걸린 시간입니다. 낮을수록 좋습니다.

| 지표 | 값 | 의미 |
|------|-----|------|
| **평균** | ${m('http_req_duration', 'avg')} ms | 전체 요청의 평균 응답 시간 |
| **중앙값 (P50)** | ${m('http_req_duration', 'med')} ms | 절반의 요청이 이 시간 내에 완료 |
| **P90** | ${m('http_req_duration', 'p(90)')} ms | 90%의 요청이 이 시간 내에 완료 |
| **P95** | ${m('http_req_duration', 'p(95)')} ms | 95%의 요청이 이 시간 내에 완료 ⭐ |
| **P99** | ${m('http_req_duration', 'p(99)')} ms | 99%의 요청이 이 시간 내에 완료 |
| **최대** | ${m('http_req_duration', 'max')} ms | 가장 느린 요청의 응답 시간 |

> 💡 **P95를 주로 보는 이유**: 평균은 극단값에 왜곡되기 쉽습니다. P95는 "대부분의 사용자 경험"을 대표합니다.

### 성공률

| 지표 | 값 | 설명 |
|------|-----|------|
| **HTTP 실패율** | ${m('http_req_failed', 'value')}% | 4xx, 5xx 응답 비율 |
| **체크 통과율** | ${((mRaw('checks', 'passes') / (mRaw('checks', 'passes') + mRaw('checks', 'fails'))) * 100).toFixed(2)}% | 비즈니스 로직 검증 통과율 |

---

## 🔌 커넥션 풀 분석

### 현재 설정: DB_POOL_SIZE = ${poolSize}

| 지표 | 평균 | 최대 | P95 | 설명 |
|------|------|------|-----|------|
| **활성 커넥션** | ${m('db_active_connections', 'avg')} | ${m('db_active_connections', 'max')} | ${m('db_active_connections', 'p(95)')} | 현재 사용 중인 커넥션 수 |
| **대기 요청** | ${m('db_waiting_requests', 'avg')} | ${m('db_waiting_requests', 'max')} | ${m('db_waiting_requests', 'p(95)')} | 커넥션을 기다리는 요청 수 |
| **커넥션 획득 시간** | ${m('db_acquire_time', 'avg')} ms | ${m('db_acquire_time', 'max')} ms | ${m('db_acquire_time', 'p(95)')} ms | 풀에서 커넥션을 얻는데 걸린 시간 |

### 해석 가이드

| 대기 요청 수 | 상태 | 의미 |
|-------------|------|------|
| 0 | ✅ 정상 | 커넥션이 충분함 |
| 1~10 | 🔶 주의 | 간헐적 대기 발생 |
| 10~50 | ⚠️ 경고 | 커넥션 풀 증가 고려 |
| 50+ | 🔴 심각 | 즉시 커넥션 풀 증가 필요 |

---

## 🧵 스레드 풀 분석

### 현재 설정: UV_THREADPOOL_SIZE = ${threadSize}

| 지표 | 평균 | 최대 | 설명 |
|------|------|------|------|
| **활성 핸들** | ${m('libuv_active_handles', 'avg') || 'N/A'} | ${m('libuv_active_handles', 'max') || 'N/A'} | 활성 I/O 작업 수 |
| **활성 요청** | ${m('libuv_active_requests', 'avg') || 'N/A'} | ${m('libuv_active_requests', 'max') || 'N/A'} | 대기 중인 비동기 작업 |

> 💡 스레드 풀은 파일 I/O, DNS 조회, bcrypt 등에 영향을 줍니다.
> CPU 집약 시나리오에서 효과가 두드러집니다.

---

## 💻 프로세스 리소스

### CPU 사용량

| 지표 | 값 | 해석 |
|------|-----|------|
| **평균** | ${m('process_cpu_percent', 'avg')}% | ${cpuAvg > 80 ? '⚠️ 높음' : cpuAvg > 50 ? '🔶 보통' : '✅ 여유'} |
| **최대** | ${m('process_cpu_percent', 'max')}% | 피크 시 CPU 사용률 |
| **P95** | ${m('process_cpu_percent', 'p(95)')}% | 대부분의 시간 동안 CPU 사용률 |

### 메모리 사용량

| 지표 | 평균 | 최대 | 설명 |
|------|------|------|------|
| **RSS** | ${m('process_memory_rss_mb', 'avg')} MB | ${m('process_memory_rss_mb', 'max')} MB | 실제 물리 메모리 사용량 |
| **힙 사용량** | ${m('process_memory_heap_used_mb', 'avg')} MB | ${m('process_memory_heap_used_mb', 'max')} MB | V8 힙 메모리 |
| **힙 사용률** | ${m('process_memory_heap_percent', 'avg')}% | ${m('process_memory_heap_percent', 'max')}% | ${heapPercent > 85 ? '⚠️ 높음' : '✅ 정상'} |

---

## 🔍 종합 분석

${bottleneckAnalysis}

---

## 💡 권장 사항

${recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}

---

## 📈 다음 단계

1. **튜닝 필요 시**: 권장사항에 따라 설정 변경 후 재테스트
2. **안정적이라면**: Stress 테스트로 시스템 한계점 확인
3. **최종 검증**: Soak 테스트로 장시간 안정성 확인

---

## 📚 용어 설명

| 용어 | 설명 |
|------|------|
| **VU (Virtual User)** | 가상 사용자. 동시에 요청을 보내는 사용자 수 |
| **RPS (Requests Per Second)** | 초당 요청 수. 서버의 처리량 |
| **P95 (95th Percentile)** | 전체 요청 중 95%가 이 값 이하. 극단값을 제외한 "실제 사용자 경험" |
| **Latency** | 지연 시간. 요청 후 응답까지 걸린 시간 |
| **Throughput** | 처리량. 단위 시간당 처리한 요청 수 |
| **Connection Pool** | 미리 만들어둔 DB 연결 모음. 매번 연결하는 오버헤드 방지 |
| **waitingRequests** | 커넥션 풀이 가득 차서 대기 중인 요청 수 |

---

*생성 시각: ${new Date().toISOString()}*
*k6 버전: ${data.metrics.vus ? 'k6' : 'unknown'}*
`;

  return {
    'stdout': report,
    [`/results/${filename}.json`]: JSON.stringify(data, null, 2),
    [`/results/${filename}_report.md`]: report,
  };
}
