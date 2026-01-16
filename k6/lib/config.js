// k6 공통 설정
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// 기본 thresholds
export const defaultThresholds = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.05'],
};

// 시나리오별 엔드포인트
export const endpoints = {
  simpleQuery: '/api/scenarios/simple-query',
  complexQuery: '/api/scenarios/complex-query',
  cpuIntensive: '/api/scenarios/cpu-intensive',
  fileAndDb: '/api/scenarios/file-and-db',
  externalApi: '/api/scenarios/external-api',
  mixed: '/api/scenarios/mixed',
  poolExhaustion: '/api/scenarios/pool-exhaustion',
  metrics: '/api/metrics/pools',
  health: '/health',
};

// 랜덤 ID 생성 (1 ~ 100000)
export function randomUserId() {
  return Math.floor(Math.random() * 100000) + 1;
}

// 랜덤 제품 ID 생성 (1 ~ 10000)
export function randomProductId() {
  return Math.floor(Math.random() * 10000) + 1;
}
