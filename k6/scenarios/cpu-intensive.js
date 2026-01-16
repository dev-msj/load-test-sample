/**
 * 시나리오 C: CPU 집약 작업 테스트
 * bcrypt 해싱, JSON 대량 파싱 (libuv 스레드 풀 사용)
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, endpoints } from '../lib/config.js';

const errorRate = new Rate('errors');
const hashTime = new Trend('bcrypt_hash_time');
const parseTime = new Trend('json_parse_time');

export const options = {
  scenarios: {
    constant_load: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '30'),
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<3000'], // CPU 작업은 긴 응답 허용
    errors: ['rate<0.05'],
  },
};

export default function () {
  const rounds = parseInt(__ENV.BCRYPT_ROUNDS || '12');
  const jsonSize = parseInt(__ENV.JSON_SIZE || '10000');

  const response = http.post(
    `${BASE_URL}${endpoints.cpuIntensive}`,
    JSON.stringify({
      password: 'loadtest' + Math.random().toString(36).substring(7),
      jsonSize: jsonSize,
      rounds: rounds,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'hash is valid': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success && body.data?.isValid === true;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);

  // 개별 작업 시간 추출
  try {
    const body = JSON.parse(response.body);
    if (body.data) {
      hashTime.add(body.data.hashTime || 0);
      parseTime.add(body.data.parseTime || 0);
    }
  } catch {}

  sleep(0.5);
}

export function handleSummary(data) {
  console.log('\n===== CPU Intensive Test Results =====');
  console.log(`UV_THREADPOOL_SIZE: ${__ENV.UV_THREADPOOL_SIZE || 'default (4)'}`);
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`Avg bcrypt Hash Time: ${(data.metrics.bcrypt_hash_time?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`Avg JSON Parse Time: ${(data.metrics.json_parse_time?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log('======================================\n');

  return {
    'cpu-intensive-result.json': JSON.stringify(data, null, 2),
  };
}
