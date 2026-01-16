/**
 * Stress 프로파일: 한계점 찾기
 * VUs를 계속 증가시켜 시스템 한계 도달
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, endpoints, randomUserId } from '../lib/config.js';
import { checkResponse, collectMetrics, jsonHeaders, errorRate } from '../lib/helpers.js';

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

  checkResponse(response, scenario);

  // 5% 확률로 메트릭 수집 (스트레스 테스트에서는 오버헤드 줄임)
  if (Math.random() < 0.05) {
    collectMetrics();
  }

  sleep(0.05);
}

export function handleSummary(data) {
  console.log('\n========== Stress Test Summary ==========');
  console.log(`Peak VUs: ${data.metrics.vus_max?.values?.max || 0}`);
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Error Rate: ${(data.metrics.http_req_failed?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log('==========================================\n');

  return {
    'stress-summary.json': JSON.stringify(data, null, 2),
  };
}
