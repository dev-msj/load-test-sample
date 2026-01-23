/**
 * Stress 프로파일: 한계점 찾기
 * VUs를 계속 증가시켜 시스템 한계 도달
 *
 * 베이스라인 비교 사용법:
 *   docker compose run --rm k6 run -e USE_BASELINE=true /scripts/profiles/stress.js
 */
import http from 'k6/http';
import { sleep } from 'k6';
import {
  BASE_URL,
  endpoints,
  randomUserId,
  getBaseline,
  isUsingBaseline,
  getBaselineTolerance,
} from '../lib/config.js';
import {
  collectMetrics,
  jsonHeaders,
  errorRate,
  getStressStage,
  checkResponseWithStage,
} from '../lib/helpers.js';
import { compareWithBaseline, formatComparisonReport } from '../lib/baseline.js';

// Stress 테스트는 한계를 찾는 것이므로 관대한 threshold 사용
// (베이스라인 기반 threshold는 사용하지 않음)
export const options = {
  stages: [
    // 초기 부하
    { duration: '2m', target: 200 },

    // 점진적 증가
    { duration: '3m', target: 500 },
    { duration: '3m', target: 1000 },
    { duration: '3m', target: 1500 },
    { duration: '3m', target: 2000 },
    { duration: '3m', target: 2500 },
    { duration: '3m', target: 3000 },

    // 쿨다운
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], // 스트레스 테스트는 더 관대한 임계값
    http_req_failed: ['rate<0.20'],    // 20% 에러율까지 허용
  },
};

export default function () {
  const scenario = __ENV.SCENARIO || 'simple-query';
  const currentVUs = __VU || 1;
  const stage = getStressStage(currentVUs);
  let response;

  switch (scenario) {
    case 'simple-query':
      response = http.get(
        `${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`
      );
      break;

    case 'complex-query':
      response = http.get(
        `${BASE_URL}${endpoints.complexQuery}?delay=50`
      );
      break;

    case 'cpu-intensive':
      response = http.post(
        `${BASE_URL}${endpoints.cpuIntensive}`,
        JSON.stringify({ password: 'stresstest', jsonSize: 3000, rounds: 10 }),
        { headers: jsonHeaders }
      );
      break;

    default:
      response = http.get(
        `${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`
      );
  }

  // 단계별 메트릭 기록
  checkResponseWithStage(response, scenario, stage);

  // 5% 확률로 메트릭 수집 (스트레스 테스트에서는 오버헤드 줄임)
  if (Math.random() < 0.05) {
    collectMetrics();
  }

  sleep(0.05);
}

export function handleSummary(data) {
  const scenario = __ENV.SCENARIO || 'simple-query';
  const poolSize = __ENV.DB_POOL_SIZE || '10';
  const threadSize = __ENV.UV_THREADPOOL_SIZE || '4';
  const filename = `stress_${scenario}_conn-${poolSize}_thread-${threadSize}`;

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

  // 핵심 지표
  const peakVUs = mRaw('vus_max', 'max') || mRaw('vus', 'max');
  const totalRequests = mRaw('http_reqs', 'count');
  const errorRateValue = mRaw('http_req_failed', 'rate') * 100;
  const responseP95 = mRaw('http_req_duration', 'p(95)');
  const responseP99 = mRaw('http_req_duration', 'p(99)');
  const waitingMax = mRaw('db_waiting_requests', 'max');
  const cpuMax = mRaw('process_cpu_percent', 'max');
  const heapMax = mRaw('process_memory_heap_percent', 'max');

  // ============================================================
  // VUs 단계별 성능 추이 분석 (Breaking Point 탐지)
  // ============================================================
  const stages = [
    { name: 'stage1', label: '0-500 VUs', vus: '~500' },
    { name: 'stage2', label: '500-1000 VUs', vus: '~1000' },
    { name: 'stage3', label: '1000-1500 VUs', vus: '~1500' },
    { name: 'stage4', label: '1500-2000 VUs', vus: '~2000' },
    { name: 'stage5', label: '2000-2500 VUs', vus: '~2500' },
    { name: 'stage6', label: '2500-3000 VUs', vus: '~3000' },
  ];

  const stageData = stages.map(stage => {
    const responseTime = mRaw(`${stage.name}_response_time`, 'avg');
    const responseP95Stage = mRaw(`${stage.name}_response_time`, 'p(95)');
    const errRate = mRaw(`${stage.name}_error_rate`, 'rate') * 100;
    const requestCount = mRaw(`${stage.name}_requests`, 'count');
    return {
      ...stage,
      responseTime,
      responseP95: responseP95Stage,
      errorRate: errRate,
      requestCount,
      hasData: requestCount > 0,
    };
  });

  // Breaking Point 탐지: 에러율이 5% 이상으로 증가하는 첫 단계
  let breakingPointStage = null;
  let firstErrorStage = null;

  for (const stage of stageData) {
    if (!stage.hasData) continue;
    if (stage.errorRate > 0 && !firstErrorStage) {
      firstErrorStage = stage;
    }
    if (stage.errorRate >= 5 && !breakingPointStage) {
      breakingPointStage = stage;
      break;
    }
  }

  // 응답 시간 급증 탐지: 이전 단계 대비 2배 이상 증가하는 지점
  let responseTimeSpike = null;
  for (let i = 1; i < stageData.length; i++) {
    const prev = stageData[i - 1];
    const curr = stageData[i];
    if (!prev.hasData || !curr.hasData) continue;
    if (prev.responseTime > 0 && curr.responseTime > prev.responseTime * 2) {
      responseTimeSpike = { from: prev, to: curr };
      break;
    }
  }

  // Breaking Point 분석
  let breakingPointAnalysis = '';
  let systemStatus = '✅ 안정';

  if (breakingPointStage) {
    breakingPointAnalysis += `🔴 **Breaking Point 발견**: ${breakingPointStage.label}에서 에러율 ${breakingPointStage.errorRate.toFixed(2)}% 발생\n`;
    systemStatus = '🔴 한계 초과';
  } else if (firstErrorStage) {
    breakingPointAnalysis += `⚠️ **첫 에러 발생 단계**: ${firstErrorStage.label}에서 에러율 ${firstErrorStage.errorRate.toFixed(2)}%\n`;
    systemStatus = '⚠️ 한계 근접';
  } else if (errorRateValue > 0) {
    breakingPointAnalysis += `🔶 **경미한 에러 발생**: 전체 에러율 ${errorRateValue.toFixed(2)}%\n`;
    systemStatus = '🔶 주의';
  } else {
    breakingPointAnalysis += `✅ **에러 없음**: 모든 단계에서 안정적 처리\n`;
  }

  if (responseTimeSpike) {
    breakingPointAnalysis += `⚠️ **응답 시간 급증**: ${responseTimeSpike.from.label} → ${responseTimeSpike.to.label}에서 `;
    breakingPointAnalysis += `${responseTimeSpike.from.responseTime.toFixed(0)}ms → ${responseTimeSpike.to.responseTime.toFixed(0)}ms로 급증\n`;
  }

  if (responseP95 > 2000) {
    breakingPointAnalysis += `🔴 **심각한 응답 지연**: P95 ${responseP95.toFixed(0)}ms\n`;
  } else if (responseP95 > 1000) {
    breakingPointAnalysis += `⚠️ **응답 지연 발생**: P95 ${responseP95.toFixed(0)}ms\n`;
  }

  // 리소스 병목 분석
  let bottleneckAnalysis = '';

  if (waitingMax > 100) {
    bottleneckAnalysis += `🔴 **커넥션 풀 고갈**: 최대 ${waitingMax.toFixed(0)}개 요청 대기\n`;
  } else if (waitingMax > 50) {
    bottleneckAnalysis += `⚠️ **커넥션 풀 부족**: 최대 ${waitingMax.toFixed(0)}개 요청 대기\n`;
  } else if (waitingMax > 10) {
    bottleneckAnalysis += `🔶 **커넥션 대기 발생**: 최대 ${waitingMax.toFixed(0)}개 요청 대기\n`;
  } else {
    bottleneckAnalysis += `✅ **커넥션 풀 여유**: 대기 요청 최대 ${waitingMax.toFixed(0)}개\n`;
  }

  if (cpuMax > 95) {
    bottleneckAnalysis += `🔴 **CPU 포화**: 최대 ${cpuMax.toFixed(1)}%\n`;
  } else if (cpuMax > 80) {
    bottleneckAnalysis += `⚠️ **높은 CPU 사용**: 최대 ${cpuMax.toFixed(1)}%\n`;
  } else {
    bottleneckAnalysis += `✅ **CPU 여유**: 최대 ${cpuMax.toFixed(1)}%\n`;
  }

  if (heapMax > 90) {
    bottleneckAnalysis += `🔴 **메모리 압박**: 힙 사용률 최대 ${heapMax.toFixed(1)}%\n`;
  } else if (heapMax > 75) {
    bottleneckAnalysis += `⚠️ **메모리 주의**: 힙 사용률 최대 ${heapMax.toFixed(1)}%\n`;
  } else {
    bottleneckAnalysis += `✅ **메모리 여유**: 힙 사용률 최대 ${heapMax.toFixed(1)}%\n`;
  }

  // 권장사항 생성
  let recommendations = [];

  if (breakingPointStage) {
    const prevStageIndex = stages.findIndex(s => s.name === breakingPointStage.name) - 1;
    if (prevStageIndex >= 0) {
      recommendations.push(`최대 안정 VUs: ${stages[prevStageIndex].vus} (이 이하로 운영 권장)`);
    }
  }
  if (waitingMax > 50) {
    recommendations.push(`DB_POOL_SIZE 증가 필요 (현재: ${poolSize}, 권장: ${Math.ceil(parseInt(poolSize) * 2)}+)`);
  }
  if (cpuMax > 80 && scenario === 'cpu-intensive') {
    recommendations.push(`UV_THREADPOOL_SIZE 증가 고려 (현재: ${threadSize})`);
  }
  if (firstErrorStage && !breakingPointStage) {
    recommendations.push(`${firstErrorStage.label} 이상에서 간헐적 에러 발생 - 모니터링 강화 필요`);
  }
  if (responseTimeSpike) {
    recommendations.push('응답 시간 급증 구간에서 리소스 병목 확인 필요');
  }
  if (recommendations.length === 0) {
    recommendations.push(`현재 설정으로 ${peakVUs} VUs까지 안정적 처리 가능`);
    recommendations.push('더 높은 부하로 한계점 재측정 고려');
  }

  // 베이스라인 비교 (USE_BASELINE=true인 경우)
  let baselineComparisonReport = '';
  if (isUsingBaseline()) {
    const baseline = getBaseline();
    const tolerance = getBaselineTolerance();
    const comparison = compareWithBaseline(data, baseline, tolerance);
    baselineComparisonReport = formatComparisonReport(comparison);
  }

  // VUs별 성능 추이 테이블 생성
  const stageTableRows = stageData
    .filter(s => s.hasData)
    .map(s => {
      const status = s.errorRate >= 5 ? '🔴' : s.errorRate > 0 ? '⚠️' : '✅';
      return `| ${s.label} | ${s.requestCount.toLocaleString()} | ${s.responseTime.toFixed(0)}ms | ${s.responseP95.toFixed(0)}ms | ${s.errorRate.toFixed(2)}% | ${status} |`;
    })
    .join('\n');

  // 마크다운 보고서 생성
  const report = `# Stress 테스트 분석 보고서

## 📋 테스트 개요

| 항목 | 값 |
|------|-----|
| **테스트 유형** | Stress (한계점 탐색) |
| **테스트 시나리오** | ${scenario} |
| **커넥션 풀 크기** | ${poolSize}개 |
| **스레드 풀 크기** | ${threadSize}개 |
| **테스트 시간** | 약 22분 |
| **최대 VUs** | ${peakVUs} |
| **시스템 상태** | ${systemStatus} |

---

## 🎯 Breaking Point 분석

> Stress 테스트의 핵심 목표는 시스템이 **언제, 어떻게** 실패하는지 파악하는 것입니다.

${breakingPointAnalysis}

### Breaking Point 요약

| 항목 | 결과 |
|------|------|
| **첫 에러 발생** | ${firstErrorStage ? `${firstErrorStage.label} (${firstErrorStage.errorRate.toFixed(2)}%)` : '없음'} |
| **Breaking Point (에러율 5%+)** | ${breakingPointStage ? `${breakingPointStage.label} (${breakingPointStage.errorRate.toFixed(2)}%)` : '도달하지 않음'} |
| **응답 시간 급증 구간** | ${responseTimeSpike ? `${responseTimeSpike.from.label} → ${responseTimeSpike.to.label}` : '없음'} |

---

## 📈 VUs 단계별 성능 추이

> 각 VUs 단계에서의 성능 변화를 추적하여 시스템의 확장성을 평가합니다.

| VUs 구간 | 요청 수 | 평균 응답 | P95 응답 | 에러율 | 상태 |
|----------|---------|----------|----------|--------|------|
${stageTableRows || '| (데이터 없음) | - | - | - | - | - |'}

### 해석 가이드

- **응답 시간 선형 증가**: 시스템이 정상적으로 확장 중
- **응답 시간 급격히 증가**: 특정 리소스 포화 (Breaking Point 근접)
- **에러율 급증**: 시스템 한계 도달 (이 VUs 직전이 최대 처리량)

---

## 📊 전체 성능 지표

### 처리량 (Throughput)

| 지표 | 값 | 설명 |
|------|-----|------|
| **총 요청 수** | ${m('http_reqs', 'count')} | 테스트 동안 처리한 전체 HTTP 요청 |
| **초당 요청 수 (RPS)** | ${m('http_reqs', 'rate')} req/sec | 평균 처리량 |
| **Peak VUs** | ${peakVUs} | 최대 동시 가상 사용자 수 |

### 응답 시간 (Response Time)

| 지표 | 값 | 상태 |
|------|-----|------|
| **평균** | ${m('http_req_duration', 'avg')} ms | - |
| **중앙값 (P50)** | ${m('http_req_duration', 'med')} ms | - |
| **P90** | ${m('http_req_duration', 'p(90)')} ms | - |
| **P95** | ${m('http_req_duration', 'p(95)')} ms | ${responseP95 > 1000 ? '⚠️' : '✅'} |
| **P99** | ${m('http_req_duration', 'p(99)')} ms | ${responseP99 > 2000 ? '⚠️' : '✅'} |
| **최대** | ${m('http_req_duration', 'max')} ms | - |

### 에러율

| 지표 | 값 | 상태 |
|------|-----|------|
| **HTTP 실패율** | ${errorRateValue.toFixed(2)}% | ${errorRateValue > 10 ? '🔴' : errorRateValue > 5 ? '⚠️' : '✅'} |
| **체크 통과율** | ${((mRaw('checks', 'passes') / (mRaw('checks', 'passes') + mRaw('checks', 'fails') || 1)) * 100).toFixed(2)}% | - |

---

## 🔌 커넥션 풀 분석

### 현재 설정: DB_POOL_SIZE = ${poolSize}

| 지표 | 평균 | 최대 | P95 |
|------|------|------|-----|
| **활성 커넥션** | ${m('db_active_connections', 'avg')} | ${m('db_active_connections', 'max')} | ${m('db_active_connections', 'p(95)')} |
| **대기 요청** | ${m('db_waiting_requests', 'avg')} | ${m('db_waiting_requests', 'max')} | ${m('db_waiting_requests', 'p(95)')} |
| **획득 시간** | ${m('db_acquire_time', 'avg')} ms | ${m('db_acquire_time', 'max')} ms | ${m('db_acquire_time', 'p(95)')} ms |

---

## 🧵 스레드 풀 분석

### 현재 설정: UV_THREADPOOL_SIZE = ${threadSize}

| 지표 | 평균 | 최대 |
|------|------|------|
| **활성 핸들** | ${m('libuv_active_handles', 'avg')} | ${m('libuv_active_handles', 'max')} |
| **활성 요청** | ${m('libuv_active_requests', 'avg')} | ${m('libuv_active_requests', 'max')} |

---

## 💻 프로세스 리소스

### CPU 사용량

| 지표 | 평균 | 최대 | P95 |
|------|------|------|-----|
| **CPU** | ${m('process_cpu_percent', 'avg')}% | ${m('process_cpu_percent', 'max')}% | ${m('process_cpu_percent', 'p(95)')}% |

### 메모리 사용량

| 지표 | 평균 | 최대 |
|------|------|------|
| **RSS** | ${m('process_memory_rss_mb', 'avg')} MB | ${m('process_memory_rss_mb', 'max')} MB |
| **힙 사용량** | ${m('process_memory_heap_used_mb', 'avg')} MB | ${m('process_memory_heap_used_mb', 'max')} MB |
| **힙 사용률** | ${m('process_memory_heap_percent', 'avg')}% | ${m('process_memory_heap_percent', 'max')}% |

---

## 🔍 병목 지점 분석

${bottleneckAnalysis}

---

${baselineComparisonReport}

## 💡 권장 사항

${recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}

---

## 📈 다음 단계

1. **에러 원인 분석**: 에러 로그에서 POOL_EXHAUSTED, ETIMEDOUT 등 확인
2. **설정 조정 후 재테스트**: 권장사항 적용 후 동일 테스트 반복
3. **Soak 테스트 진행**: 최적 설정으로 장시간 안정성 검증

---

*생성 시각: ${new Date().toISOString()}*
`;

  // 콘솔 출력
  console.log('\n========== Stress Test Summary ==========');
  console.log(`Peak VUs: ${peakVUs}`);
  console.log(`Total Requests: ${totalRequests}`);
  console.log(`Error Rate: ${errorRateValue.toFixed(2)}%`);
  console.log(`P95 Response Time: ${responseP95.toFixed(2)}ms`);
  console.log(`Breaking Point: ${breakingPointStage ? breakingPointStage.label : 'Not reached'}`);
  console.log(`First Error: ${firstErrorStage ? firstErrorStage.label : 'None'}`);
  console.log(`System Status: ${systemStatus}`);
  console.log('==========================================\n');

  return {
    'stdout': report,
    [`/results/${filename}.json`]: JSON.stringify(data, null, 2),
    [`/results/${filename}_report.md`]: report,
  };
}
