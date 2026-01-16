/**
 * Soak 프로파일: 장시간 안정성 테스트
 * 일정 부하를 30분 이상 유지
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, endpoints, randomUserId } from '../lib/config.js';
import { checkResponse, collectMetrics, jsonHeaders, errorRate } from '../lib/helpers.js';

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

  checkResponse(response, scenario);

  // 1% 확률로 메트릭 수집 (장시간 테스트에서는 최소화)
  if (Math.random() < 0.01) {
    collectMetrics();
  }

  sleep(0.1);
}

export function handleSummary(data) {
  const duration = data.state?.testRunDurationMs || 0;
  const durationMinutes = Math.floor(duration / 60000);

  console.log('\n========== Soak Test Summary ==========');
  console.log(`Test Duration: ${durationMinutes} minutes`);
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Error Rate: ${(data.metrics.http_req_failed?.values?.rate * 100 || 0).toFixed(4)}%`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log('=========================================\n');

  return {
    'soak-summary.json': JSON.stringify(data, null, 2),
  };
}
