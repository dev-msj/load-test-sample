/**
 * 베이스라인(Baseline) 설정 및 비교 모듈
 *
 * 베이스라인은 성능 테스트의 기준점으로, 이후 테스트 결과와 비교하여
 * 성능 저하를 감지하는 데 사용됩니다.
 */

// 베이스라인 파일 경로 (k6 컨테이너 내부 경로)
const BASELINE_FILE_PATH = '/results/baseline.json';

/**
 * 베이스라인 파일 로드
 * @returns {object|null} 베이스라인 데이터 또는 null (파일 없음/파싱 실패)
 */
export function loadBaseline() {
  try {
    // k6에서는 open() 함수로 파일을 읽음 (init 단계에서만 사용 가능)
    const data = open(BASELINE_FILE_PATH);
    const baseline = JSON.parse(data);

    console.log(`[Baseline] 베이스라인 로드 성공: ${baseline.metadata?.createdAt || 'unknown'}`);
    return baseline;
  } catch (e) {
    console.log('[Baseline] 베이스라인 파일이 없거나 로드 실패. 기본 threshold 사용.');
    return null;
  }
}

/**
 * 테스트 summary 데이터에서 베이스라인 생성
 * @param {object} summaryData - k6 handleSummary에서 받은 data 객체
 * @param {object} options - 추가 옵션 (vus, duration 등)
 * @returns {object} 베이스라인 JSON 객체
 */
export function createBaselineFromSummary(summaryData, options = {}) {
  const metrics = summaryData.metrics || {};

  // 메트릭 값 추출 헬퍼
  const getValue = (metricName, field) => {
    const metric = metrics[metricName];
    if (!metric) return 0;
    return metric[field] !== undefined ? metric[field] : (metric.values?.[field] || 0);
  };

  const baseline = {
    metadata: {
      createdAt: new Date().toISOString(),
      vus: options.vus || 100,
      duration: options.duration || '5m',
      scenario: options.scenario || 'mixed',
      profile: options.profile || 'baseline',
    },
    metrics: {
      http_req_duration: {
        avg: getValue('http_req_duration', 'avg'),
        med: getValue('http_req_duration', 'med'),
        p90: getValue('http_req_duration', 'p(90)'),
        p95: getValue('http_req_duration', 'p(95)'),
        p99: getValue('http_req_duration', 'p(99)'),
        max: getValue('http_req_duration', 'max'),
      },
      http_req_failed: {
        rate: getValue('http_req_failed', 'rate'),
      },
      http_reqs: {
        count: getValue('http_reqs', 'count'),
        rate: getValue('http_reqs', 'rate'),
      },
    },
  };

  return baseline;
}

/**
 * 베이스라인 기반 동적 threshold 생성
 * @param {object} baseline - 베이스라인 데이터
 * @param {number} tolerance - 허용 편차 (%, 기본값: 20)
 * @returns {object} k6 thresholds 객체
 */
export function generateThresholds(baseline, tolerance = 20) {
  if (!baseline || !baseline.metrics) {
    // 베이스라인이 없으면 기본 threshold 반환
    return {
      http_req_duration: ['p(95)<500', 'p(99)<1000'],
      http_req_failed: ['rate<0.05'],
    };
  }

  const metrics = baseline.metrics;
  const factor = 1 + (tolerance / 100);

  // P95 기반 threshold 계산
  const p95Threshold = Math.ceil(metrics.http_req_duration.p95 * factor);
  const p99Threshold = Math.ceil(metrics.http_req_duration.p99 * factor);

  // 에러율 threshold (베이스라인의 2배까지 허용, 최소 1%)
  const errorThreshold = Math.max(
    metrics.http_req_failed.rate * 2,
    0.01
  );

  return {
    http_req_duration: [
      `p(95)<${p95Threshold}`,
      `p(99)<${p99Threshold}`,
    ],
    http_req_failed: [`rate<${errorThreshold.toFixed(4)}`],
  };
}

/**
 * 현재 테스트 결과와 베이스라인 비교
 * @param {object} summaryData - k6 handleSummary에서 받은 data 객체
 * @param {object} baseline - 베이스라인 데이터
 * @param {number} tolerance - 허용 편차 (%, 기본값: 20)
 * @returns {object} 비교 결과 (regressions, improvements, summary)
 */
export function compareWithBaseline(summaryData, baseline, tolerance = 20) {
  if (!baseline || !baseline.metrics) {
    return {
      hasBaseline: false,
      regressions: [],
      improvements: [],
      summary: '베이스라인이 없어 비교할 수 없습니다.',
    };
  }

  const metrics = summaryData.metrics || {};
  const baselineMetrics = baseline.metrics;

  // 메트릭 값 추출 헬퍼
  const getValue = (metricName, field) => {
    const metric = metrics[metricName];
    if (!metric) return 0;
    return metric[field] !== undefined ? metric[field] : (metric.values?.[field] || 0);
  };

  const regressions = [];
  const improvements = [];
  const toleranceFactor = tolerance / 100;

  // 응답 시간 비교 (P95)
  const currentP95 = getValue('http_req_duration', 'p(95)');
  const baselineP95 = baselineMetrics.http_req_duration.p95;
  if (baselineP95 > 0) {
    const p95Change = ((currentP95 - baselineP95) / baselineP95) * 100;
    const p95Result = {
      metric: 'http_req_duration (P95)',
      baseline: `${baselineP95.toFixed(2)}ms`,
      current: `${currentP95.toFixed(2)}ms`,
      change: `${p95Change >= 0 ? '+' : ''}${p95Change.toFixed(1)}%`,
    };

    if (p95Change > tolerance) {
      regressions.push({ ...p95Result, severity: p95Change > tolerance * 2 ? 'critical' : 'warning' });
    } else if (p95Change < -toleranceFactor * 50) {
      improvements.push(p95Result);
    }
  }

  // 응답 시간 비교 (P99)
  const currentP99 = getValue('http_req_duration', 'p(99)');
  const baselineP99 = baselineMetrics.http_req_duration.p99;
  if (baselineP99 > 0) {
    const p99Change = ((currentP99 - baselineP99) / baselineP99) * 100;
    const p99Result = {
      metric: 'http_req_duration (P99)',
      baseline: `${baselineP99.toFixed(2)}ms`,
      current: `${currentP99.toFixed(2)}ms`,
      change: `${p99Change >= 0 ? '+' : ''}${p99Change.toFixed(1)}%`,
    };

    if (p99Change > tolerance * 1.5) {
      regressions.push({ ...p99Result, severity: p99Change > tolerance * 3 ? 'critical' : 'warning' });
    } else if (p99Change < -toleranceFactor * 50) {
      improvements.push(p99Result);
    }
  }

  // 에러율 비교
  const currentErrorRate = getValue('http_req_failed', 'rate') * 100;
  const baselineErrorRate = baselineMetrics.http_req_failed.rate * 100;
  const errorRateResult = {
    metric: 'http_req_failed (에러율)',
    baseline: `${baselineErrorRate.toFixed(4)}%`,
    current: `${currentErrorRate.toFixed(4)}%`,
    change: `${(currentErrorRate - baselineErrorRate) >= 0 ? '+' : ''}${(currentErrorRate - baselineErrorRate).toFixed(4)}%p`,
  };

  // 에러율이 베이스라인보다 0.5%p 이상 증가하면 regression
  if (currentErrorRate > baselineErrorRate + 0.5) {
    regressions.push({ ...errorRateResult, severity: currentErrorRate > 5 ? 'critical' : 'warning' });
  } else if (currentErrorRate < baselineErrorRate - 0.1 && baselineErrorRate > 0) {
    improvements.push(errorRateResult);
  }

  // 처리량 비교 (RPS)
  const currentRPS = getValue('http_reqs', 'rate');
  const baselineRPS = baselineMetrics.http_reqs.rate;
  if (baselineRPS > 0) {
    const rpsChange = ((currentRPS - baselineRPS) / baselineRPS) * 100;
    const rpsResult = {
      metric: 'http_reqs (처리량)',
      baseline: `${baselineRPS.toFixed(2)} req/s`,
      current: `${currentRPS.toFixed(2)} req/s`,
      change: `${rpsChange >= 0 ? '+' : ''}${rpsChange.toFixed(1)}%`,
    };

    // 처리량이 20% 이상 감소하면 regression
    if (rpsChange < -20) {
      regressions.push({ ...rpsResult, severity: rpsChange < -40 ? 'critical' : 'warning' });
    } else if (rpsChange > 20) {
      improvements.push(rpsResult);
    }
  }

  // 종합 판정
  let summary;
  const criticalCount = regressions.filter(r => r.severity === 'critical').length;
  const warningCount = regressions.filter(r => r.severity === 'warning').length;

  if (criticalCount > 0) {
    summary = `🔴 심각한 성능 저하 감지: ${criticalCount}개 지표가 기준치를 크게 초과`;
  } else if (warningCount > 0) {
    summary = `⚠️ 성능 저하 감지: ${warningCount}개 지표가 허용 범위(${tolerance}%) 초과`;
  } else if (improvements.length > 0) {
    summary = `✅ 성능 개선: ${improvements.length}개 지표가 베이스라인 대비 향상`;
  } else {
    summary = `✅ 성능 안정: 모든 지표가 베이스라인 허용 범위 내`;
  }

  return {
    hasBaseline: true,
    regressions,
    improvements,
    summary,
    baselineInfo: {
      createdAt: baseline.metadata?.createdAt,
      vus: baseline.metadata?.vus,
      duration: baseline.metadata?.duration,
    },
    tolerance,
  };
}

/**
 * 베이스라인 비교 결과를 마크다운 형식으로 변환
 * @param {object} comparison - compareWithBaseline()의 반환값
 * @returns {string} 마크다운 형식의 비교 리포트
 */
export function formatComparisonReport(comparison) {
  if (!comparison.hasBaseline) {
    return `
## 📊 베이스라인 비교

> ⚠️ 베이스라인이 없습니다. 먼저 베이스라인을 수집하세요.
>
> \`\`\`bash
> docker compose run --rm k6 run -e SAVE_BASELINE=true /scripts/profiles/baseline.js
> \`\`\`
`;
  }

  let report = `
## 📊 베이스라인 비교

### 비교 기준

| 항목 | 값 |
|------|-----|
| **베이스라인 생성일** | ${comparison.baselineInfo.createdAt || 'N/A'} |
| **베이스라인 VUs** | ${comparison.baselineInfo.vus || 'N/A'} |
| **베이스라인 Duration** | ${comparison.baselineInfo.duration || 'N/A'} |
| **허용 편차** | ${comparison.tolerance}% |

### 판정 결과

${comparison.summary}

`;

  if (comparison.regressions.length > 0) {
    report += `
### 🔻 성능 저하 항목

| 지표 | 베이스라인 | 현재 | 변화 | 심각도 |
|------|-----------|------|------|--------|
`;
    for (const r of comparison.regressions) {
      const severityIcon = r.severity === 'critical' ? '🔴' : '⚠️';
      report += `| ${r.metric} | ${r.baseline} | ${r.current} | ${r.change} | ${severityIcon} |\n`;
    }
  }

  if (comparison.improvements.length > 0) {
    report += `
### 🔺 성능 개선 항목

| 지표 | 베이스라인 | 현재 | 변화 |
|------|-----------|------|------|
`;
    for (const i of comparison.improvements) {
      report += `| ${i.metric} | ${i.baseline} | ${i.current} | ${i.change} |\n`;
    }
  }

  if (comparison.regressions.length === 0 && comparison.improvements.length === 0) {
    report += `
> 모든 지표가 베이스라인 허용 범위 내에 있습니다.
`;
  }

  return report;
}
