/**
 * 시나리오 B: 복잡한 쿼리 테스트
 * JOIN 3개 이상, 집계 함수 포함, 예상 응답시간 100~200ms
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, endpoints, randomUserId } from '../lib/config.js';

const errorRate = new Rate('errors');
const queryTime = new Trend('complex_query_time');

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '50'),
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'], // 복잡한 쿼리는 더 긴 응답 허용
    errors: ['rate<0.05'],
  },
};

export default function () {
  const delay = parseInt(__ENV.DELAY || '100');
  const userId = Math.random() < 0.5 ? randomUserId() : undefined;

  let url = `${BASE_URL}${endpoints.complexQuery}?delay=${delay}`;
  if (userId) {
    url += `&userId=${userId}`;
  }

  const response = http.get(url);

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
    'has summary data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success && body.data?.summary;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  queryTime.add(response.timings.duration);

  sleep(0.2);
}

export function handleSummary(data) {
  console.log('\n===== Complex Query Test Results =====');
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`P99 Response Time: ${(data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log('======================================\n');

  return {
    'complex-query-result.json': JSON.stringify(data, null, 2),
  };
}
