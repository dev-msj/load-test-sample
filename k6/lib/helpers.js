import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { BASE_URL, endpoints } from './config.js';

// 커스텀 메트릭
export const errorRate = new Rate('errors');
export const dbAcquireTime = new Trend('db_acquire_time');
export const dbActiveConnections = new Trend('db_active_connections');
export const dbWaitingRequests = new Trend('db_waiting_requests');

// 프로세스 리소스 메트릭
export const processCpuPercent = new Trend('process_cpu_percent');
export const processMemoryRss = new Trend('process_memory_rss_mb');
export const processMemoryHeapUsed = new Trend('process_memory_heap_used_mb');
export const processMemoryHeapPercent = new Trend('process_memory_heap_percent');

// ============================================================
// 시간대별/단계별 메트릭 (Phase-based Metrics)
// ============================================================

// Soak 테스트용: 시간 구간별 메트릭 (early: 0-10분, mid: 10-20분, late: 20-30분)
export const phaseResponseTime = {
  early: new Trend('phase_early_response_time'),
  mid: new Trend('phase_mid_response_time'),
  late: new Trend('phase_late_response_time'),
};

export const phaseErrorRate = {
  early: new Rate('phase_early_error_rate'),
  mid: new Rate('phase_mid_error_rate'),
  late: new Rate('phase_late_error_rate'),
};

export const phaseMemoryHeap = {
  early: new Trend('phase_early_memory_heap'),
  mid: new Trend('phase_mid_memory_heap'),
  late: new Trend('phase_late_memory_heap'),
};

export const phaseWaitingRequests = {
  early: new Trend('phase_early_waiting_requests'),
  mid: new Trend('phase_mid_waiting_requests'),
  late: new Trend('phase_late_waiting_requests'),
};

export const phaseRequestCount = {
  early: new Counter('phase_early_requests'),
  mid: new Counter('phase_mid_requests'),
  late: new Counter('phase_late_requests'),
};

// Stress 테스트용: VUs 단계별 메트릭
export const stageResponseTime = {
  stage1: new Trend('stage1_response_time'),  // 0-500 VUs
  stage2: new Trend('stage2_response_time'),  // 500-1000 VUs
  stage3: new Trend('stage3_response_time'),  // 1000-1500 VUs
  stage4: new Trend('stage4_response_time'),  // 1500-2000 VUs
  stage5: new Trend('stage5_response_time'),  // 2000-2500 VUs
  stage6: new Trend('stage6_response_time'),  // 2500-3000 VUs
};

export const stageErrorRate = {
  stage1: new Rate('stage1_error_rate'),
  stage2: new Rate('stage2_error_rate'),
  stage3: new Rate('stage3_error_rate'),
  stage4: new Rate('stage4_error_rate'),
  stage5: new Rate('stage5_error_rate'),
  stage6: new Rate('stage6_error_rate'),
};

export const stageRequestCount = {
  stage1: new Counter('stage1_requests'),
  stage2: new Counter('stage2_requests'),
  stage3: new Counter('stage3_requests'),
  stage4: new Counter('stage4_requests'),
  stage5: new Counter('stage5_requests'),
  stage6: new Counter('stage6_requests'),
};

// Ramp-Up 테스트용: VUs 레벨별 메트릭
export const levelResponseTime = {
  level50: new Trend('level_50_response_time'),
  level100: new Trend('level_100_response_time'),
  level200: new Trend('level_200_response_time'),
};

export const levelErrorRate = {
  level50: new Rate('level_50_error_rate'),
  level100: new Rate('level_100_error_rate'),
  level200: new Rate('level_200_error_rate'),
};

export const levelWaitingRequests = {
  level50: new Trend('level_50_waiting_requests'),
  level100: new Trend('level_100_waiting_requests'),
  level200: new Trend('level_200_waiting_requests'),
};

// ============================================================
// 시간/단계 판별 유틸리티 함수
// ============================================================

/**
 * Soak 테스트용: 경과 시간 기준 현재 구간 반환
 * @param {number} startTime - 테스트 시작 시간 (ms)
 * @returns {'early'|'mid'|'late'} 현재 구간
 */
export function getSoakPhase(startTime) {
  const elapsedMinutes = (Date.now() - startTime) / 1000 / 60;
  if (elapsedMinutes < 10) return 'early';
  if (elapsedMinutes < 20) return 'mid';
  return 'late';
}

/**
 * Stress 테스트용: 현재 VUs 기준 단계 반환
 * @param {number} vus - 현재 VUs 수
 * @returns {'stage1'|'stage2'|'stage3'|'stage4'|'stage5'|'stage6'} 현재 단계
 */
export function getStressStage(vus) {
  if (vus <= 500) return 'stage1';
  if (vus <= 1000) return 'stage2';
  if (vus <= 1500) return 'stage3';
  if (vus <= 2000) return 'stage4';
  if (vus <= 2500) return 'stage5';
  return 'stage6';
}

/**
 * Ramp-Up 테스트용: 현재 VUs 기준 레벨 반환
 * @param {number} vus - 현재 VUs 수
 * @returns {'level50'|'level100'|'level200'} 현재 레벨
 */
export function getRampUpLevel(vus) {
  if (vus <= 75) return 'level50';
  if (vus <= 150) return 'level100';
  return 'level200';
}

// HTTP 헤더
export const jsonHeaders = {
  'Content-Type': 'application/json',
};

/**
 * 응답 검증 및 에러율 기록
 */
export function checkResponse(response, name) {
  const success = check(response, {
    [`${name}: status is 200`]: (r) => r.status === 200,
    [`${name}: response time < 500ms`]: (r) => r.timings.duration < 500,
    [`${name}: has success field`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!success);
  return success;
}

/**
 * 메트릭 수집 및 기록
 */
export function collectMetrics() {
  const response = http.get(`${BASE_URL}${endpoints.metrics}`);

  if (response.status === 200) {
    try {
      const metrics = JSON.parse(response.body);

      // 데이터베이스 메트릭
      if (metrics.database) {
        dbAcquireTime.add(metrics.database.acquireTime?.avg || 0);
        dbActiveConnections.add(metrics.database.activeConnections || 0);
        dbWaitingRequests.add(metrics.database.waitingRequests || 0);
      }

      // 프로세스 리소스 메트릭
      if (metrics.process) {
        processCpuPercent.add(metrics.process.cpu?.percent || 0);
        processMemoryRss.add(metrics.process.memory?.rss || 0);
        processMemoryHeapUsed.add(metrics.process.memory?.heapUsed || 0);
        processMemoryHeapPercent.add(metrics.process.memory?.percentUsed || 0);
      }

      return metrics;
    } catch (e) {
      console.warn('Failed to parse metrics response');
    }
  }

  return null;
}

/**
 * 테스트 결과 요약 출력
 */
export function printSummary(data) {
  console.log('\n========== Test Summary ==========');
  console.log(`Total Requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Error Rate: ${(data.metrics.errors?.values?.rate * 100 || 0).toFixed(2)}%`);
  console.log(`Avg Response Time: ${(data.metrics.http_req_duration?.values?.avg || 0).toFixed(2)}ms`);
  console.log(`P95 Response Time: ${(data.metrics.http_req_duration?.values['p(95)'] || 0).toFixed(2)}ms`);
  console.log(`P99 Response Time: ${(data.metrics.http_req_duration?.values['p(99)'] || 0).toFixed(2)}ms`);
  console.log('==================================\n');
}

// ============================================================
// 단계별/시간대별 메트릭 수집 함수
// ============================================================

/**
 * Soak 테스트용: 시간 구간별 응답 검증 및 메트릭 기록
 * @param {object} response - HTTP 응답 객체
 * @param {string} name - 시나리오 이름
 * @param {string} phase - 현재 구간 ('early'|'mid'|'late')
 */
export function checkResponseWithPhase(response, name, phase) {
  const success = check(response, {
    [`${name}: status is 200`]: (r) => r.status === 200,
    [`${name}: has success field`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
  });

  // 전체 에러율
  errorRate.add(!success);

  // 구간별 메트릭 기록
  if (phaseResponseTime[phase]) {
    phaseResponseTime[phase].add(response.timings.duration);
    phaseErrorRate[phase].add(!success);
    phaseRequestCount[phase].add(1);
  }

  return success;
}

/**
 * Soak 테스트용: 시간 구간별 서버 메트릭 수집
 * @param {string} phase - 현재 구간 ('early'|'mid'|'late')
 */
export function collectMetricsWithPhase(phase) {
  const response = http.get(`${BASE_URL}${endpoints.metrics}`);

  if (response.status === 200) {
    try {
      const metrics = JSON.parse(response.body);

      // 전체 메트릭 기록
      if (metrics.database) {
        dbAcquireTime.add(metrics.database.acquireTime?.avg || 0);
        dbActiveConnections.add(metrics.database.activeConnections || 0);
        dbWaitingRequests.add(metrics.database.waitingRequests || 0);
      }

      if (metrics.process) {
        processCpuPercent.add(metrics.process.cpu?.percent || 0);
        processMemoryRss.add(metrics.process.memory?.rss || 0);
        processMemoryHeapUsed.add(metrics.process.memory?.heapUsed || 0);
        processMemoryHeapPercent.add(metrics.process.memory?.percentUsed || 0);
      }

      // 구간별 메트릭 기록
      if (phaseMemoryHeap[phase] && metrics.process?.memory) {
        phaseMemoryHeap[phase].add(metrics.process.memory.heapUsed || 0);
      }
      if (phaseWaitingRequests[phase] && metrics.database) {
        phaseWaitingRequests[phase].add(metrics.database.waitingRequests || 0);
      }

      return metrics;
    } catch (e) {
      console.warn('Failed to parse metrics response');
    }
  }

  return null;
}

/**
 * Stress 테스트용: VUs 단계별 응답 검증 및 메트릭 기록
 * @param {object} response - HTTP 응답 객체
 * @param {string} name - 시나리오 이름
 * @param {string} stage - 현재 단계 ('stage1'|...|'stage6')
 */
export function checkResponseWithStage(response, name, stage) {
  const success = check(response, {
    [`${name}: status is 200`]: (r) => r.status === 200,
    [`${name}: has success field`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
  });

  // 전체 에러율
  errorRate.add(!success);

  // 단계별 메트릭 기록
  if (stageResponseTime[stage]) {
    stageResponseTime[stage].add(response.timings.duration);
    stageErrorRate[stage].add(!success);
    stageRequestCount[stage].add(1);
  }

  return success;
}

/**
 * Ramp-Up 테스트용: VUs 레벨별 응답 검증 및 메트릭 기록
 * @param {object} response - HTTP 응답 객체
 * @param {string} name - 시나리오 이름
 * @param {string} level - 현재 레벨 ('level50'|'level100'|'level200')
 */
export function checkResponseWithLevel(response, name, level) {
  const success = check(response, {
    [`${name}: status is 200`]: (r) => r.status === 200,
    [`${name}: response time < 500ms`]: (r) => r.timings.duration < 500,
    [`${name}: has success field`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
  });

  // 전체 에러율
  errorRate.add(!success);

  // 레벨별 메트릭 기록
  if (levelResponseTime[level]) {
    levelResponseTime[level].add(response.timings.duration);
    levelErrorRate[level].add(!success);
  }

  return success;
}

/**
 * Ramp-Up 테스트용: VUs 레벨별 서버 메트릭 수집
 * @param {string} level - 현재 레벨 ('level50'|'level100'|'level200')
 */
export function collectMetricsWithLevel(level) {
  const response = http.get(`${BASE_URL}${endpoints.metrics}`);

  if (response.status === 200) {
    try {
      const metrics = JSON.parse(response.body);

      // 전체 메트릭 기록
      if (metrics.database) {
        dbAcquireTime.add(metrics.database.acquireTime?.avg || 0);
        dbActiveConnections.add(metrics.database.activeConnections || 0);
        dbWaitingRequests.add(metrics.database.waitingRequests || 0);
      }

      if (metrics.process) {
        processCpuPercent.add(metrics.process.cpu?.percent || 0);
        processMemoryRss.add(metrics.process.memory?.rss || 0);
        processMemoryHeapUsed.add(metrics.process.memory?.heapUsed || 0);
        processMemoryHeapPercent.add(metrics.process.memory?.percentUsed || 0);
      }

      // 레벨별 대기 요청 기록
      if (levelWaitingRequests[level] && metrics.database) {
        levelWaitingRequests[level].add(metrics.database.waitingRequests || 0);
      }

      return metrics;
    } catch (e) {
      console.warn('Failed to parse metrics response');
    }
  }

  return null;
}
