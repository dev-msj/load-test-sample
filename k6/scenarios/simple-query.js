/**
 * 시나리오 A: 단순 쿼리 테스트
 * PK로 단일 건 조회, 예상 응답시간 5~10ms
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, endpoints, randomUserId, defaultThresholds } from '../lib/config.js';

const errorRate = new Rate('errors');
const acquireTime = new Trend('db_acquire_time');

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '100'),
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<100', 'p(99)<200'], // 단순 쿼리는 빠른 응답 기대
    errors: ['rate<0.01'],
  },
};

export default function () {
  const userId = randomUserId();
  const response = http.get(`${BASE_URL}${endpoints.simpleQuery}?id=${userId}`);

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 100ms': (r) => r.timings.duration < 100,
    'has user data': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success && body.data;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);

  // acquireTime 추출
  try {
    const body = JSON.parse(response.body);
    if (body.data?.acquireTime) {
      acquireTime.add(body.data.acquireTime);
    }
  } catch {}

  sleep(0.1);
}

export function handleSummary(data) {
  console.log('\n===== Simple Query Test Results =====');
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`Avg DB Acquire Time: ${(data.metrics.db_acquire_time?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log('=====================================\n');

  return {
    'simple-query-result.json': JSON.stringify(data, null, 2),
  };
}
