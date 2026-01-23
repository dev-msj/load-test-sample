import { loadBaseline, generateThresholds } from './baseline.js';

// k6 공통 설정
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// 환경변수
const USE_BASELINE = __ENV.USE_BASELINE === 'true';
const BASELINE_TOLERANCE = parseInt(__ENV.BASELINE_TOLERANCE) || 20;

// 기본 thresholds
export const defaultThresholds = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.05'],
};

// 베이스라인 로드 (init 단계에서 한 번만 실행)
let loadedBaseline = null;
if (USE_BASELINE) {
  loadedBaseline = loadBaseline();
}

/**
 * Thresholds 반환 함수
 * USE_BASELINE=true이고 베이스라인이 있으면 동적 threshold 반환,
 * 아니면 기본 threshold 반환
 *
 * @returns {object} k6 thresholds 객체
 */
export function getThresholds() {
  if (USE_BASELINE && loadedBaseline) {
    console.log(`[Config] 베이스라인 기반 동적 threshold 적용 (tolerance: ${BASELINE_TOLERANCE}%)`);
    return generateThresholds(loadedBaseline, BASELINE_TOLERANCE);
  }
  return defaultThresholds;
}

/**
 * 로드된 베이스라인 반환
 * @returns {object|null} 베이스라인 데이터
 */
export function getBaseline() {
  return loadedBaseline;
}

/**
 * 베이스라인 사용 여부 확인
 * @returns {boolean}
 */
export function isUsingBaseline() {
  return USE_BASELINE && loadedBaseline !== null;
}

/**
 * 베이스라인 허용 편차 반환
 * @returns {number}
 */
export function getBaselineTolerance() {
  return BASELINE_TOLERANCE;
}

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
