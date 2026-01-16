import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
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
