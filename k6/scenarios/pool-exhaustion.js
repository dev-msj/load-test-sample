/**
 * 풀 고갈 테스트
 * 의도적으로 커넥션을 오래 점유하여 풀 고갈 상황 유발
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { BASE_URL, endpoints } from '../lib/config.js';

const errorRate = new Rate('errors');
const poolExhaustedErrors = new Counter('pool_exhausted_errors');
const successfulHolds = new Counter('successful_holds');

export const options = {
  scenarios: {
    exhaust_pool: {
      executor: 'constant-vus',
      vus: parseInt(__ENV.VUS || '20'), // 커넥션 풀 사이즈보다 많은 VUs
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    // 풀 고갈 테스트는 에러가 예상됨
    http_req_duration: ['p(95)<10000'],
  },
};

export default function () {
  const holdTime = parseInt(__ENV.HOLD_TIME || '5000'); // 5초 동안 커넥션 점유

  const response = http.get(
    `${BASE_URL}${endpoints.poolExhaustion}?holdTime=${holdTime}`,
    {
      timeout: holdTime + 10000, // holdTime + 10초 타임아웃
    }
  );

  const success = check(response, {
    'status is 200': (r) => r.status === 200,
    'connection held': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success && body.data?.released === true;
      } catch {
        return false;
      }
    },
  });

  if (success) {
    successfulHolds.add(1);
  } else {
    errorRate.add(1);

    // 풀 고갈 에러 카운트
    if (response.status === 503 || response.body?.includes('POOL_EXHAUSTED')) {
      poolExhaustedErrors.add(1);
    }
  }

  // 풀 고갈 테스트에서는 sleep 없이 바로 다음 요청
  sleep(0.1);
}

export function handleSummary(data) {
  console.log('\n===== Pool Exhaustion Test Results =====');
  console.log(`DB_POOL_SIZE: ${__ENV.DB_POOL_SIZE || 'default (10)'}`);
  console.log(`Hold Time: ${__ENV.HOLD_TIME || '5000'}ms`);
  console.log(`VUs: ${__ENV.VUS || '20'}`);
  console.log(`---`);
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Successful Holds: ${data.metrics.successful_holds?.values?.count || 0}`);
  console.log(`Pool Exhausted Errors: ${data.metrics.pool_exhausted_errors?.values?.count || 0}`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log('========================================\n');

  return {
    'pool-exhaustion-result.json': JSON.stringify(data, null, 2),
  };
}
