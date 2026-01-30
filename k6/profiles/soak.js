/**
 * Soak 프로파일: 장시간 안정성 테스트
 * 일정 부하를 30분 이상 유지
 *
 * 베이스라인 비교 사용법:
 *   docker compose run --rm k6 run -e USE_BASELINE=true /scripts/profiles/soak.js
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
  jsonHeaders,
  errorRate,
  getSoakPhase,
  checkResponseWithPhase,
  collectMetricsWithPhase,
} from '../lib/helpers.js';
import { compareWithBaseline, formatComparisonReport } from '../lib/baseline.js';
import { evaluateSLA, formatSLAReport, exportSLAResult } from '../lib/sla.js';

// 테스트 시작 시간 저장 (모든 VU에서 공유)
const TEST_START_TIME = Date.now();

export const options = {
  stages: [
    // 워밍업
    { duration: '2m', target: 500 },

    // 장시간 유지 (30분)
    { duration: '30m', target: 500 },

    // 쿨다운
    { duration: '2m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'], // Soak 테스트는 더 엄격한 에러율
  },
};

export default function () {
  const scenario = __ENV.SCENARIO || 'mixed';
  const phase = getSoakPhase(TEST_START_TIME);
  let response;

  // Soak 테스트는 실제 워크로드와 유사하게 mixed 사용 권장
  if (scenario === 'mixed') {
    response = http.post(
      `${BASE_URL}${endpoints.mixed}`,
      JSON.stringify({
        weights: {
          simple: 50,
          complex: 20,
          cpu: 10,
          file: 5,
          external: 15,
        },
      }),
      { headers: jsonHeaders }
    );
  } else {
    response = http.get(
      `${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`
    );
  }

  // 시간 구간별 메트릭 기록
  checkResponseWithPhase(response, scenario, phase);

  // 1% 확률로 메트릭 수집 (장시간 테스트에서는 최소화)
  if (Math.random() < 0.01) {
    collectMetricsWithPhase(phase);
  }

  sleep(0.1);
}

export function handleSummary(data) {
  const scenario = __ENV.SCENARIO || 'mixed';
  const poolSize = __ENV.DB_POOL_SIZE || '10';
  const threadSize = __ENV.UV_THREADPOOL_SIZE || '4';
  const filename = `soak_${scenario}_conn-${poolSize}_thread-${threadSize}`;

  const duration = data.state?.testRunDurationMs || 0;
  const durationMinutes = Math.floor(duration / 60000);

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
  const totalRequests = mRaw('http_reqs', 'count');
  const errorRateValue = mRaw('http_req_failed', 'rate') * 100;
  const responseAvg = mRaw('http_req_duration', 'avg');
  const responseP95 = mRaw('http_req_duration', 'p(95)');
  const responseP99 = mRaw('http_req_duration', 'p(99)');

  // 전체 메모리 지표
  const heapAvg = mRaw('process_memory_heap_used_mb', 'avg');
  const heapMax = mRaw('process_memory_heap_used_mb', 'max');
  const heapMin = mRaw('process_memory_heap_used_mb', 'min');
  const heapPercentAvg = mRaw('process_memory_heap_percent', 'avg');
  const heapPercentMax = mRaw('process_memory_heap_percent', 'max');
  const rssAvg = mRaw('process_memory_rss_mb', 'avg');
  const rssMax = mRaw('process_memory_rss_mb', 'max');

  // 커넥션 풀 지표
  const activeConnAvg = mRaw('db_active_connections', 'avg');
  const waitingAvg = mRaw('db_waiting_requests', 'avg');
  const waitingMax = mRaw('db_waiting_requests', 'max');

  // CPU 지표
  const cpuAvg = mRaw('process_cpu_percent', 'avg');
  const cpuMax = mRaw('process_cpu_percent', 'max');

  // ============================================================
  // 시간대별 성능 추이 분석
  // ============================================================
  const phases = [
    { name: 'early', label: '초기 (0-10분)', minutes: '0-10' },
    { name: 'mid', label: '중기 (10-20분)', minutes: '10-20' },
    { name: 'late', label: '후기 (20-30분)', minutes: '20-30' },
  ];

  const phaseData = phases.map(phase => {
    const responseTime = mRaw(`phase_${phase.name}_response_time`, 'avg');
    const responseP95Phase = mRaw(`phase_${phase.name}_response_time`, 'p(95)');
    const errRate = mRaw(`phase_${phase.name}_error_rate`, 'rate') * 100;
    const requestCount = mRaw(`phase_${phase.name}_requests`, 'count');
    const memoryHeap = mRaw(`phase_${phase.name}_memory_heap`, 'avg');
    const waiting = mRaw(`phase_${phase.name}_waiting_requests`, 'avg');
    return {
      ...phase,
      responseTime,
      responseP95: responseP95Phase,
      errorRate: errRate,
      requestCount,
      memoryHeap,
      waitingRequests: waiting,
      hasData: requestCount > 0,
    };
  });

  // 성능 저하 (Degradation) 감지
  const earlyPhase = phaseData.find(p => p.name === 'early');
  const latePhase = phaseData.find(p => p.name === 'late');

  let degradationAnalysis = '';
  let hasDegradation = false;

  if (earlyPhase?.hasData && latePhase?.hasData) {
    // 응답 시간 저하 감지
    if (earlyPhase.responseTime > 0) {
      const responseIncrease = ((latePhase.responseTime - earlyPhase.responseTime) / earlyPhase.responseTime) * 100;
      if (responseIncrease > 50) {
        degradationAnalysis += `🔴 **응답 시간 심각한 저하**: 초기 대비 ${responseIncrease.toFixed(1)}% 증가 (${earlyPhase.responseTime.toFixed(0)}ms → ${latePhase.responseTime.toFixed(0)}ms)\n`;
        hasDegradation = true;
      } else if (responseIncrease > 20) {
        degradationAnalysis += `⚠️ **응답 시간 저하 감지**: 초기 대비 ${responseIncrease.toFixed(1)}% 증가\n`;
        hasDegradation = true;
      } else if (responseIncrease > 0) {
        degradationAnalysis += `✅ **응답 시간 안정**: 초기 대비 ${responseIncrease.toFixed(1)}% 변화 (정상 범위)\n`;
      } else {
        degradationAnalysis += `✅ **응답 시간 안정**: 시간 경과에 따른 저하 없음\n`;
      }
    }

    // 메모리 누수 감지
    if (earlyPhase.memoryHeap > 0) {
      const memoryIncrease = ((latePhase.memoryHeap - earlyPhase.memoryHeap) / earlyPhase.memoryHeap) * 100;
      if (memoryIncrease > 50) {
        degradationAnalysis += `🔴 **메모리 누수 의심**: 초기 대비 ${memoryIncrease.toFixed(1)}% 증가 (${earlyPhase.memoryHeap.toFixed(1)}MB → ${latePhase.memoryHeap.toFixed(1)}MB)\n`;
        hasDegradation = true;
      } else if (memoryIncrease > 25) {
        degradationAnalysis += `⚠️ **메모리 증가 추세**: 초기 대비 ${memoryIncrease.toFixed(1)}% 증가\n`;
        hasDegradation = true;
      } else {
        degradationAnalysis += `✅ **메모리 안정**: 초기 대비 ${memoryIncrease.toFixed(1)}% 변화 (정상 범위)\n`;
      }
    }

    // 에러율 변화 감지
    if (latePhase.errorRate > earlyPhase.errorRate + 0.5) {
      degradationAnalysis += `⚠️ **에러율 증가**: 초기 ${earlyPhase.errorRate.toFixed(2)}% → 후기 ${latePhase.errorRate.toFixed(2)}%\n`;
      hasDegradation = true;
    } else {
      degradationAnalysis += `✅ **에러율 안정**: 시간 경과에 따른 에러 증가 없음\n`;
    }
  } else {
    degradationAnalysis = '⚠️ 시간대별 데이터가 충분하지 않아 추이 분석 불가\n';
  }

  // 전체 메모리 추이 분석
  let memoryAnalysis = '';
  let memoryStatus = '✅ 안정';
  const heapGrowth = heapMax - heapMin;
  const heapGrowthPercent = heapMin > 0 ? (heapGrowth / heapMin) * 100 : 0;

  if (heapGrowthPercent > 50) {
    memoryAnalysis += `🔴 **메모리 누수 의심**: 힙 메모리가 ${heapGrowthPercent.toFixed(1)}% 증가 (${heapMin.toFixed(1)}MB → ${heapMax.toFixed(1)}MB)\n`;
    memoryStatus = '🔴 누수 의심';
  } else if (heapGrowthPercent > 25) {
    memoryAnalysis += `⚠️ **메모리 증가 추세**: 힙 메모리가 ${heapGrowthPercent.toFixed(1)}% 증가\n`;
    memoryStatus = '⚠️ 주의';
  } else {
    memoryAnalysis += `✅ **메모리 안정**: 힙 메모리 변동 ${heapGrowthPercent.toFixed(1)}% 이내\n`;
  }

  if (heapPercentMax > 90) {
    memoryAnalysis += `🔴 **힙 메모리 압박**: 최대 사용률 ${heapPercentMax.toFixed(1)}%\n`;
    memoryStatus = '🔴 압박';
  } else if (heapPercentMax > 75) {
    memoryAnalysis += `⚠️ **힙 사용률 높음**: 최대 ${heapPercentMax.toFixed(1)}%\n`;
  } else {
    memoryAnalysis += `✅ **힙 사용률 여유**: 최대 ${heapPercentMax.toFixed(1)}%\n`;
  }

  // 커넥션 풀 안정성 분석
  let connectionAnalysis = '';
  let connectionStatus = '✅ 안정';

  if (waitingMax > 50) {
    connectionAnalysis += `🔴 **커넥션 풀 불안정**: 최대 ${waitingMax.toFixed(0)}개 요청 대기\n`;
    connectionStatus = '🔴 불안정';
  } else if (waitingAvg > 10) {
    connectionAnalysis += `⚠️ **지속적 커넥션 대기**: 평균 ${waitingAvg.toFixed(1)}개 요청 대기\n`;
    connectionStatus = '⚠️ 주의';
  } else {
    connectionAnalysis += `✅ **커넥션 풀 안정**: 대기 요청 거의 없음\n`;
  }

  const poolUtilization = (activeConnAvg / parseInt(poolSize)) * 100;
  if (poolUtilization > 90) {
    connectionAnalysis += `⚠️ **풀 사용률 높음**: 평균 ${poolUtilization.toFixed(1)}% 사용\n`;
  } else {
    connectionAnalysis += `✅ **풀 사용률 적정**: 평균 ${poolUtilization.toFixed(1)}% 사용\n`;
  }

  // 성능 안정성 분석
  let performanceAnalysis = '';
  let performanceStatus = '✅ 안정';

  if (responseP95 > 500) {
    performanceAnalysis += `⚠️ **응답 지연**: P95 ${responseP95.toFixed(0)}ms (임계값 500ms 초과)\n`;
    performanceStatus = '⚠️ 지연';
  } else {
    performanceAnalysis += `✅ **빠른 응답 유지**: P95 ${responseP95.toFixed(0)}ms\n`;
  }

  if (errorRateValue > 1) {
    performanceAnalysis += `🔴 **에러 발생**: 에러율 ${errorRateValue.toFixed(4)}% (임계값 1% 초과)\n`;
    performanceStatus = '🔴 불안정';
  } else if (errorRateValue > 0.1) {
    performanceAnalysis += `⚠️ **경미한 에러**: 에러율 ${errorRateValue.toFixed(4)}%\n`;
  } else {
    performanceAnalysis += `✅ **에러 없음**: 에러율 ${errorRateValue.toFixed(4)}%\n`;
  }

  // 종합 안정성 판정
  let overallStatus = '✅ 장시간 운영 적합';
  if (memoryStatus.includes('🔴') || connectionStatus.includes('🔴') || performanceStatus.includes('🔴') || hasDegradation) {
    overallStatus = '🔴 장시간 운영 부적합 - 즉시 조치 필요';
  } else if (memoryStatus.includes('⚠️') || connectionStatus.includes('⚠️') || performanceStatus.includes('⚠️')) {
    overallStatus = '⚠️ 조건부 적합 - 모니터링 필요';
  }

  // 권장사항 생성
  let recommendations = [];

  if (heapGrowthPercent > 25 || (latePhase?.memoryHeap > earlyPhase?.memoryHeap * 1.25)) {
    recommendations.push('메모리 누수 가능성 점검: 이벤트 리스너, 캐시, 클로저 확인');
  }
  if (waitingAvg > 5) {
    recommendations.push(`커넥션 풀 증가 고려 (현재: ${poolSize}, 권장: ${Math.ceil(parseInt(poolSize) * 1.5)})`);
  }
  if (errorRateValue > 0.1) {
    recommendations.push('에러 로그 분석으로 간헐적 실패 원인 파악');
  }
  if (responseP95 > 300 || (latePhase?.responseTime > earlyPhase?.responseTime * 1.2)) {
    recommendations.push('쿼리 최적화 또는 캐싱으로 응답 시간 개선');
  }
  if (cpuAvg > 70) {
    recommendations.push('CPU 사용률 높음 - 스케일 아웃 또는 최적화 검토');
  }
  if (recommendations.length === 0) {
    recommendations.push(`현재 설정으로 ${durationMinutes}분간 안정적으로 운영 가능`);
    recommendations.push('프로덕션 배포 준비 완료');
  }

  // 베이스라인 비교 (USE_BASELINE=true인 경우)
  let baselineComparisonReport = '';
  if (isUsingBaseline()) {
    const baseline = getBaseline();
    const tolerance = getBaselineTolerance();
    const comparison = compareWithBaseline(data, baseline, tolerance);
    baselineComparisonReport = formatComparisonReport(comparison);
  }

  // SLA 평가
  const stageDataForSLA = {};
  for (const phase of phaseData) {
    stageDataForSLA[phase.name] = phase;
  }

  const slaEvaluation = evaluateSLA(data, {
    scenario,
    profile: 'soak',
    stageData: stageDataForSLA,
  });
  const slaReport = formatSLAReport(slaEvaluation);

  // 시간대별 추이 테이블 생성
  const phaseTableRows = phaseData
    .filter(p => p.hasData)
    .map(p => {
      const status = p.errorRate > 1 ? '🔴' : p.errorRate > 0.1 ? '⚠️' : '✅';
      return `| ${p.label} | ${p.requestCount.toLocaleString()} | ${p.responseTime.toFixed(0)}ms | ${p.responseP95.toFixed(0)}ms | ${p.memoryHeap.toFixed(1)}MB | ${p.errorRate.toFixed(2)}% | ${status} |`;
    })
    .join('\n');

  // 마크다운 보고서 생성
  const report = `# Soak 테스트 분석 보고서

## 📋 테스트 개요

| 항목 | 값 |
|------|-----|
| **테스트 유형** | Soak (장시간 안정성 검증) |
| **테스트 시나리오** | ${scenario} |
| **커넥션 풀 크기** | ${poolSize}개 |
| **스레드 풀 크기** | ${threadSize}개 |
| **테스트 시간** | ${durationMinutes}분 |
| **총 요청 수** | ${totalRequests.toLocaleString()} |
| **종합 판정** | ${overallStatus} |

---

## 🎯 Soak 테스트 핵심 목표

> 장시간 일정한 부하에서 시스템의 **안정성**과 **리소스 누수**를 검증합니다.

### 주요 검증 항목

| 항목 | 상태 | 설명 |
|------|------|------|
| **메모리 안정성** | ${memoryStatus} | 힙 메모리 누수 여부 |
| **커넥션 풀 안정성** | ${connectionStatus} | DB 커넥션 누수/고갈 여부 |
| **성능 안정성** | ${performanceStatus} | 응답 시간 저하 여부 |

---

## 📈 시간대별 성능 추이

> 테스트 진행에 따른 성능 변화를 추적하여 장기 안정성을 평가합니다.

| 구간 | 요청 수 | 평균 응답 | P95 응답 | 힙 메모리 | 에러율 | 상태 |
|------|---------|----------|----------|-----------|--------|------|
${phaseTableRows || '| (데이터 없음) | - | - | - | - | - | - |'}

### 성능 저하 (Degradation) 분석

${degradationAnalysis}

---

## 🧠 메모리 분석

### 힙 메모리 추이

| 지표 | 값 | 설명 |
|------|-----|------|
| **최소** | ${heapMin.toFixed(2)} MB | 테스트 시작 시점 근처 |
| **평균** | ${heapAvg.toFixed(2)} MB | 전체 평균 |
| **최대** | ${heapMax.toFixed(2)} MB | 피크 메모리 |
| **증가량** | ${heapGrowth.toFixed(2)} MB (${heapGrowthPercent.toFixed(1)}%) | ${heapGrowthPercent > 25 ? '⚠️ 주의' : '✅ 정상'} |

### 힙 사용률

| 지표 | 평균 | 최대 |
|------|------|------|
| **힙 사용률** | ${heapPercentAvg.toFixed(1)}% | ${heapPercentMax.toFixed(1)}% |

### RSS 메모리

| 지표 | 평균 | 최대 |
|------|------|------|
| **RSS** | ${rssAvg.toFixed(2)} MB | ${rssMax.toFixed(2)} MB |

### 분석 결과

${memoryAnalysis}

> 💡 **메모리 누수 판단 기준**: 시간 경과에 따라 GC 후에도 기준선이 계속 상승하면 누수 의심

---

## 🔌 커넥션 풀 안정성

### 현재 설정: DB_POOL_SIZE = ${poolSize}

| 지표 | 평균 | 최대 | P95 |
|------|------|------|-----|
| **활성 커넥션** | ${m('db_active_connections', 'avg')} | ${m('db_active_connections', 'max')} | ${m('db_active_connections', 'p(95)')} |
| **대기 요청** | ${m('db_waiting_requests', 'avg')} | ${m('db_waiting_requests', 'max')} | ${m('db_waiting_requests', 'p(95)')} |
| **획득 시간** | ${m('db_acquire_time', 'avg')} ms | ${m('db_acquire_time', 'max')} ms | ${m('db_acquire_time', 'p(95)')} ms |

### 분석 결과

${connectionAnalysis}

---

## 📊 성능 지표

### 응답 시간

| 지표 | 값 | 임계값 | 상태 |
|------|-----|--------|------|
| **평균** | ${responseAvg.toFixed(2)} ms | - | - |
| **P50** | ${m('http_req_duration', 'med')} ms | - | - |
| **P95** | ${responseP95.toFixed(2)} ms | 500ms | ${responseP95 > 500 ? '⚠️' : '✅'} |
| **P99** | ${responseP99.toFixed(2)} ms | 1000ms | ${responseP99 > 1000 ? '⚠️' : '✅'} |
| **최대** | ${m('http_req_duration', 'max')} ms | - | - |

### 처리량

| 지표 | 값 |
|------|-----|
| **총 요청 수** | ${totalRequests.toLocaleString()} |
| **초당 요청 수 (RPS)** | ${m('http_reqs', 'rate')} req/sec |
| **에러율** | ${errorRateValue.toFixed(4)}% |

### 분석 결과

${performanceAnalysis}

---

## 🧵 스레드 풀 분석

### 현재 설정: UV_THREADPOOL_SIZE = ${threadSize}

| 지표 | 평균 | 최대 |
|------|------|------|
| **활성 핸들** | ${m('libuv_active_handles', 'avg')} | ${m('libuv_active_handles', 'max')} |
| **활성 요청** | ${m('libuv_active_requests', 'avg')} | ${m('libuv_active_requests', 'max')} |

---

## 💻 CPU 사용량

| 지표 | 평균 | 최대 | P95 |
|------|------|------|-----|
| **CPU** | ${cpuAvg.toFixed(1)}% | ${cpuMax.toFixed(1)}% | ${m('process_cpu_percent', 'p(95)')}% |

---

## 🔍 종합 분석

### 장시간 운영 적합성: ${overallStatus}

| 검증 항목 | 결과 |
|-----------|------|
| 메모리 누수 | ${heapGrowthPercent > 25 ? '⚠️ 점검 필요' : '✅ 정상'} |
| 커넥션 풀 안정성 | ${waitingAvg > 10 ? '⚠️ 점검 필요' : '✅ 정상'} |
| 응답 시간 저하 | ${hasDegradation ? '⚠️ 점검 필요' : '✅ 정상'} |
| 에러율 | ${errorRateValue > 1 ? '⚠️ 점검 필요' : '✅ 정상'} |

---

${slaReport}

---

${baselineComparisonReport}

## 💡 권장 사항

${recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}

---

## 📈 다음 단계

1. **문제 발견 시**: 권장사항 적용 후 Soak 테스트 재실행
2. **안정성 확인 시**: 프로덕션 배포 준비
3. **추가 검증**: 더 긴 시간(1시간+) 또는 더 높은 부하로 재테스트

---

*생성 시각: ${new Date().toISOString()}*
*테스트 지속 시간: ${durationMinutes}분*
`;

  // 콘솔 출력
  console.log('\n========== Soak Test Summary ==========');
  console.log(`Test Duration: ${durationMinutes} minutes`);
  console.log(`Total Requests: ${totalRequests.toLocaleString()}`);
  console.log(`Error Rate: ${errorRateValue.toFixed(4)}%`);
  console.log(`Avg Response Time: ${responseAvg.toFixed(2)}ms`);
  console.log(`P95 Response Time: ${responseP95.toFixed(2)}ms`);
  console.log(`Memory Growth: ${heapGrowthPercent.toFixed(1)}%`);
  console.log(`Degradation Detected: ${hasDegradation ? 'Yes' : 'No'}`);
  console.log(`Overall Status: ${overallStatus}`);
  console.log('=========================================\n');

  return {
    'stdout': report,
    [`/results/${filename}.json`]: JSON.stringify(data, null, 2),
    [`/results/${filename}_report.md`]: report,
    [`/results/${filename}_sla.json`]: exportSLAResult(slaEvaluation),
  };
}
