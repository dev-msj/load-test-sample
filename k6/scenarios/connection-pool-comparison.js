/**
 * 커넥션 풀 사이즈 비교 테스트
 * 동일한 부하에서 다른 풀 사이즈의 영향 관찰
 *
 * 사용법:
 * DB_POOL_SIZE=5 docker-compose up -d
 * k6 run k6/scenarios/connection-pool-comparison.js --env POOL_SIZE=5
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { BASE_URL, endpoints, randomUserId } from '../lib/config.js';

const errorRate = new Rate('errors');
const waitingRequests = new Trend('db_waiting_requests');
const activeConnections = new Trend('db_active_connections');
const responseTime = new Trend('response_time');

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 200 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    errors: ['rate<0.10'],
  },
};

export default function () {
  // 단순 쿼리와 복잡한 쿼리 혼합
  const useComplexQuery = Math.random() < 0.3;
  let response;

  if (useComplexQuery) {
    response = http.get(`${BASE_URL}${endpoints.complexQuery}?delay=50`);
  } else {
    response = http.get(`${BASE_URL}${endpoints.simpleQuery}?id=${randomUserId()}`);
  }

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
  });

  errorRate.add(!success);
  responseTime.add(response.timings.duration);

  // 주기적으로 메트릭 수집
  if (Math.random() < 0.1) {
    const metricsResponse = http.get(`${BASE_URL}${endpoints.metrics}`);
    if (metricsResponse.status === 200) {
      try {
        const metrics = JSON.parse(metricsResponse.body);
        waitingRequests.add(metrics.database?.waitingRequests || 0);
        activeConnections.add(metrics.database?.activeConnections || 0);
      } catch {}
    }
  }

  sleep(0.05);
}

export function handleSummary(data) {
  const poolSize = __ENV.POOL_SIZE || 'unknown';

  console.log(`\n===== Connection Pool Comparison (POOL_SIZE=${poolSize}) =====`);
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Avg Response Time: ${(data.metrics.response_time?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`P99 Response Time: ${(data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms`);
  console.log(`Avg Waiting Requests: ${(data.metrics.db_waiting_requests?.values?.avg || 0).toFixed(2)}`);
  console.log(`Max Waiting Requests: ${data.metrics.db_waiting_requests?.values?.max || 0}`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log('===========================================================\n');

  return {
    [`pool-comparison-${poolSize}.json`]: JSON.stringify(data, null, 2),
  };
}
