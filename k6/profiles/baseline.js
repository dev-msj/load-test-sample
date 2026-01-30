/**
 * Baseline 프로파일: 베이스라인 수집용 안정적 부하 테스트
 *
 * 100 VUs로 5분간 안정적인 부하를 가하여 기준 성능 지표를 수집합니다.
 * 수집된 결과는 이후 테스트의 비교 기준으로 사용됩니다.
 *
 * 사용법:
 *   docker compose run --rm k6 run -e SAVE_BASELINE=true /scripts/profiles/baseline.js
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, endpoints, randomUserId, defaultThresholds } from '../lib/config.js';
import { jsonHeaders, errorRate, checkResponse, collectMetrics } from '../lib/helpers.js';
import { createBaselineFromSummary } from '../lib/baseline.js';
import { evaluateSLA, formatSLAReport, exportSLAResult } from '../lib/sla.js';

// 환경변수
const SAVE_BASELINE = __ENV.SAVE_BASELINE === 'true';
const SCENARIO = __ENV.SCENARIO || 'mixed';
const BASELINE_VUS = parseInt(__ENV.BASELINE_VUS) || 100;
const BASELINE_DURATION = __ENV.BASELINE_DURATION || '5m';

export const options = {
  stages: [
    // 워밍업: 목표 VUs까지 점진적 증가
    { duration: '30s', target: BASELINE_VUS },

    // 안정 상태: 일정 부하 유지 (5분)
    { duration: BASELINE_DURATION, target: BASELINE_VUS },

    // 쿨다운
    { duration: '30s', target: 0 },
  ],
  thresholds: defaultThresholds,
};

export default function () {
  let response;

  switch (SCENARIO) {
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
        JSON.stringify({ password: 'baseline123', jsonSize: 5000 }),
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

    case 'mixed':
    default:
      // Mixed: 실제 워크로드와 유사한 비율로 요청
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
  }

  checkResponse(response, SCENARIO);

  // 10% 확률로 메트릭 수집
  if (Math.random() < 0.1) {
    collectMetrics();
  }

  sleep(0.1);
}

export function handleSummary(data) {
  const poolSize = __ENV.DB_POOL_SIZE || '10';
  const threadSize = __ENV.UV_THREADPOOL_SIZE || '4';

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
  const rps = mRaw('http_reqs', 'rate');
  const errorRateValue = mRaw('http_req_failed', 'rate') * 100;
  const responseAvg = mRaw('http_req_duration', 'avg');
  const responseP95 = mRaw('http_req_duration', 'p(95)');
  const responseP99 = mRaw('http_req_duration', 'p(99)');

  // SLA 평가
  const slaEvaluation = evaluateSLA(data, {
    scenario: SCENARIO,
    profile: 'baseline',
  });
  const slaReport = formatSLAReport(slaEvaluation);

  // 베이스라인 저장 여부 확인
  let baselineMessage = '';
  const outputs = {};

  // SLA 평가 결과 파일 추가
  outputs[`/results/baseline_${SCENARIO}_sla.json`] = exportSLAResult(slaEvaluation);

  if (SAVE_BASELINE) {
    const baseline = createBaselineFromSummary(data, {
      vus: BASELINE_VUS,
      duration: BASELINE_DURATION,
      scenario: SCENARIO,
      profile: 'baseline',
    });

    outputs['/results/baseline.json'] = JSON.stringify(baseline, null, 2);
    baselineMessage = `
> **베이스라인 저장됨**: \`/results/baseline.json\`
>
> 이 베이스라인을 사용하여 다른 테스트와 비교할 수 있습니다:
> \`\`\`bash
> docker compose run --rm k6 run -e USE_BASELINE=true /scripts/profiles/ramp-up.js
> \`\`\`
`;
  } else {
    baselineMessage = `
> **베이스라인 미저장**: \`SAVE_BASELINE=true\` 환경변수가 설정되지 않았습니다.
>
> 베이스라인을 저장하려면:
> \`\`\`bash
> docker compose run --rm k6 run -e SAVE_BASELINE=true /scripts/profiles/baseline.js
> \`\`\`
`;
  }

  // 마크다운 보고서 생성
  const report = `# 베이스라인 수집 보고서

## 📋 테스트 개요

| 항목 | 값 |
|------|-----|
| **테스트 유형** | Baseline (기준 성능 수집) |
| **테스트 시나리오** | ${SCENARIO} |
| **VUs** | ${BASELINE_VUS} |
| **테스트 시간** | ${BASELINE_DURATION} |
| **커넥션 풀 크기** | ${poolSize}개 |
| **스레드 풀 크기** | ${threadSize}개 |
| **베이스라인 저장** | ${SAVE_BASELINE ? '✅ 예' : '❌ 아니오'} |

---

## 📊 수집된 베이스라인 지표

### 응답 시간

| 지표 | 값 | 설명 |
|------|-----|------|
| **평균** | ${responseAvg.toFixed(2)} ms | 전체 요청의 평균 응답 시간 |
| **중앙값 (P50)** | ${m('http_req_duration', 'med')} ms | 50%의 요청이 이 시간 내에 완료 |
| **P90** | ${m('http_req_duration', 'p(90)')} ms | 90%의 요청이 이 시간 내에 완료 |
| **P95** | ${responseP95.toFixed(2)} ms | 95%의 요청이 이 시간 내에 완료 ⭐ |
| **P99** | ${responseP99.toFixed(2)} ms | 99%의 요청이 이 시간 내에 완료 |
| **최대** | ${m('http_req_duration', 'max')} ms | 가장 느린 요청 |

### 처리량 및 에러율

| 지표 | 값 |
|------|-----|
| **총 요청 수** | ${totalRequests.toLocaleString()} |
| **초당 요청 수 (RPS)** | ${rps.toFixed(2)} req/s |
| **에러율** | ${errorRateValue.toFixed(4)}% |

### 리소스 사용량

| 지표 | 평균 | 최대 |
|------|------|------|
| **CPU** | ${m('process_cpu_percent', 'avg')}% | ${m('process_cpu_percent', 'max')}% |
| **힙 메모리** | ${m('process_memory_heap_used_mb', 'avg')} MB | ${m('process_memory_heap_used_mb', 'max')} MB |
| **활성 커넥션** | ${m('db_active_connections', 'avg')} | ${m('db_active_connections', 'max')} |
| **대기 요청** | ${m('db_waiting_requests', 'avg')} | ${m('db_waiting_requests', 'max')} |

---

## 💾 베이스라인 저장 상태

${baselineMessage}

---

${slaReport}

---

## 🎯 베이스라인 활용 방법

### 1. 동적 Threshold 적용

\`USE_BASELINE=true\`로 테스트를 실행하면, 베이스라인 P95 + tolerance(기본 20%)로 threshold가 자동 설정됩니다.

| 현재 베이스라인 P95 | Tolerance | 자동 생성 Threshold |
|---------------------|-----------|---------------------|
| ${responseP95.toFixed(2)} ms | 20% | p(95)<${Math.ceil(responseP95 * 1.2)} |

### 2. 성능 비교 리포트

테스트 결과에 베이스라인 대비 성능 변화가 자동으로 리포트됩니다:
- 응답 시간 증가 → 🔻 성능 저하
- 응답 시간 감소 → 🔺 성능 개선
- 에러율 변화 추적

---

## 📈 다음 단계

1. **베이스라인 저장**: \`SAVE_BASELINE=true\`로 실행하여 기준점 저장
2. **코드 변경 후 테스트**: \`USE_BASELINE=true\`로 비교 테스트 수행
3. **성능 회귀 감지**: 리포트에서 성능 저하 항목 확인

---

*생성 시각: ${new Date().toISOString()}*
`;

  // 콘솔 출력
  console.log('\n========== Baseline Collection Summary ==========');
  console.log(`Scenario: ${SCENARIO}`);
  console.log(`VUs: ${BASELINE_VUS}, Duration: ${BASELINE_DURATION}`);
  console.log(`Total Requests: ${totalRequests.toLocaleString()}`);
  console.log(`RPS: ${rps.toFixed(2)} req/s`);
  console.log(`Error Rate: ${errorRateValue.toFixed(4)}%`);
  console.log(`Avg Response Time: ${responseAvg.toFixed(2)}ms`);
  console.log(`P95 Response Time: ${responseP95.toFixed(2)}ms`);
  console.log(`P99 Response Time: ${responseP99.toFixed(2)}ms`);
  console.log(`Baseline Saved: ${SAVE_BASELINE ? 'Yes (/results/baseline.json)' : 'No'}`);
  console.log('=================================================\n');

  return {
    'stdout': report,
    [`/results/baseline_${SCENARIO}_report.md`]: report,
    ...outputs,
  };
}
