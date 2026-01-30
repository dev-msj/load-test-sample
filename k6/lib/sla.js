/**
 * SLA (Service Level Agreement) 정의 및 평가 모듈
 *
 * 서비스 수준 목표(SLO)를 정의하고 테스트 결과가 SLA를 충족하는지 평가합니다.
 */

// ============================================================
// 환경변수
// ============================================================
const SLA_OVERRIDE = __ENV.SLA_OVERRIDE;
const SLA_TOLERANCE = parseInt(__ENV.SLA_TOLERANCE) || 0;

// ============================================================
// 기본 SLA 정의
// ============================================================

/**
 * 기본 SLA 설정
 * 모든 시나리오와 프로파일에 공통으로 적용되는 기준
 */
export const defaultSLA = {
  availability: 99.9, // 99.9% 가용성 (에러율 0.1% 이하)
  responseTime: {
    p50: 100, // 중앙값 100ms 이하
    p95: 300, // 95% 요청 300ms 이하
    p99: 500, // 99% 요청 500ms 이하
  },
  errorRate: 0.1, // 0.1% 이하
  throughput: 100, // 최소 100 RPS
};

/**
 * 시나리오별 SLA 설정
 * 시나리오 특성에 맞는 개별 기준
 */
export const scenarioSLA = {
  'simple-query': {
    responseTime: { p50: 50, p95: 100, p99: 200 },
    errorRate: 0.01,
  },
  'complex-query': {
    responseTime: { p50: 150, p95: 400, p99: 600 },
    errorRate: 0.1,
  },
  'cpu-intensive': {
    responseTime: { p50: 400, p95: 600, p99: 1000 },
    errorRate: 0.5,
  },
  'file-and-db': {
    responseTime: { p50: 100, p95: 200, p99: 400 },
    errorRate: 0.1,
  },
  'external-api': {
    responseTime: { p50: 300, p95: 500, p99: 800 },
    errorRate: 0.5,
  },
  mixed: {
    responseTime: { p50: 150, p95: 350, p99: 600 },
    errorRate: 0.2,
  },
};

/**
 * 프로파일별 SLA 설정
 * VUs 레벨/단계에 따른 차등 기준
 */
export const profileSLA = {
  'ramp-up': {
    level50: {
      responseTime: { p95: 200 },
      errorRate: 0.1,
    },
    level100: {
      responseTime: { p95: 300 },
      errorRate: 0.5,
    },
    level200: {
      responseTime: { p95: 500 },
      errorRate: 1.0,
    },
  },
  stress: {
    stage1: {
      responseTime: { p95: 300 },
      errorRate: 0.5,
    },
    stage2: {
      responseTime: { p95: 500 },
      errorRate: 1.0,
    },
    stage3: {
      responseTime: { p95: 800 },
      errorRate: 2.0,
    },
    stage4: {
      responseTime: { p95: 1200 },
      errorRate: 5.0,
    },
    stage5: {
      responseTime: { p95: 1500 },
      errorRate: 10.0,
    },
    stage6: {
      responseTime: { p95: 2000 },
      errorRate: 15.0,
    },
  },
  soak: {
    early: {
      responseTime: { p95: 300 },
      errorRate: 0.1,
    },
    mid: {
      responseTime: { p95: 350 },
      errorRate: 0.2,
    },
    late: {
      responseTime: { p95: 400 },
      errorRate: 0.3,
    },
  },
  baseline: {
    responseTime: { p95: 300 },
    errorRate: 0.1,
  },
};

// ============================================================
// SLA 조회 함수
// ============================================================

/**
 * 시나리오와 프로파일에 맞는 SLA 반환
 * 우선순위: 환경변수 > 시나리오별 > 기본값
 *
 * @param {string} scenario - 시나리오 이름
 * @param {string} _profile - 프로파일 이름 (향후 확장용, 현재 미사용)
 * @returns {object} SLA 설정
 */
export function getSLA(scenario, _profile) {
  // 환경변수 오버라이드 처리
  let overrideSLA = null;
  if (SLA_OVERRIDE) {
    try {
      overrideSLA = JSON.parse(SLA_OVERRIDE);
    } catch (e) {
      console.log('[SLA] SLA_OVERRIDE 파싱 실패, 기본 SLA 사용');
    }
  }

  // 기본 SLA에서 시작
  let sla = { ...defaultSLA };

  // 시나리오별 SLA 병합
  if (scenario && scenarioSLA[scenario]) {
    sla = mergeSLA(sla, scenarioSLA[scenario]);
  }

  // 환경변수 오버라이드 병합 (최종)
  if (overrideSLA) {
    sla = mergeSLA(sla, overrideSLA);
  }

  // tolerance 적용
  if (SLA_TOLERANCE > 0) {
    sla = applySLATolerance(sla, SLA_TOLERANCE);
  }

  return sla;
}

/**
 * 프로파일의 특정 단계에 맞는 SLA 반환
 *
 * @param {string} profile - 프로파일 이름
 * @param {string} stage - 단계 이름 (level50, stage1, early 등)
 * @returns {object|null} 단계별 SLA 설정
 */
export function getStageSLA(profile, stage) {
  const profileConfig = profileSLA[profile];
  if (!profileConfig) return null;

  const stageSLA = profileConfig[stage];
  if (!stageSLA) return null;

  // tolerance 적용
  if (SLA_TOLERANCE > 0) {
    return applySLATolerance(stageSLA, SLA_TOLERANCE);
  }

  return stageSLA;
}

// ============================================================
// SLA 평가 함수
// ============================================================

/**
 * SLA 평가 수행
 *
 * @param {object} data - k6 handleSummary에서 받은 data 객체
 * @param {object} options - 평가 옵션
 * @param {string} options.scenario - 시나리오 이름
 * @param {string} options.profile - 프로파일 이름
 * @param {object} options.stageData - 단계별 메트릭 데이터 (선택)
 * @returns {object} SLA 평가 결과
 */
export function evaluateSLA(data, options = {}) {
  const { scenario = 'mixed', profile = 'ramp-up', stageData = null } = options;

  // SLA 로드
  const sla = getSLA(scenario, profile);

  // 메트릭 추출 헬퍼
  const getValue = (metricName, field) => {
    const metric = data.metrics?.[metricName];
    if (!metric) return 0;
    return metric[field] !== undefined ? metric[field] : (metric.values?.[field] || 0);
  };

  // 전체 평가 항목
  const items = [];

  // 응답 시간 평가
  if (sla.responseTime) {
    if (sla.responseTime.p50 !== undefined) {
      const actual = getValue('http_req_duration', 'med');
      items.push(evaluateItem('responseTime', 'p50', sla.responseTime.p50, actual, 'ms'));
    }
    if (sla.responseTime.p95 !== undefined) {
      const actual = getValue('http_req_duration', 'p(95)');
      items.push(evaluateItem('responseTime', 'p95', sla.responseTime.p95, actual, 'ms'));
    }
    if (sla.responseTime.p99 !== undefined) {
      const actual = getValue('http_req_duration', 'p(99)');
      items.push(evaluateItem('responseTime', 'p99', sla.responseTime.p99, actual, 'ms'));
    }
  }

  // 에러율 평가
  if (sla.errorRate !== undefined) {
    const actual = getValue('http_req_failed', 'rate') * 100;
    items.push(evaluateItem('errorRate', 'rate', sla.errorRate, actual, '%'));
  }

  // 가용성 평가 (에러율의 역)
  if (sla.availability !== undefined) {
    const errorRate = getValue('http_req_failed', 'rate') * 100;
    const actual = 100 - errorRate;
    items.push(evaluateItem('availability', 'percentage', sla.availability, actual, '%', true));
  }

  // 처리량 평가
  if (sla.throughput !== undefined) {
    const actual = getValue('http_reqs', 'rate');
    items.push(evaluateItem('throughput', 'rps', sla.throughput, actual, 'req/s', true));
  }

  // 단계별 평가
  const stages = {};
  if (stageData && profile) {
    const profileConfig = profileSLA[profile];
    if (profileConfig) {
      for (const [stageName, stageMetrics] of Object.entries(stageData)) {
        const stageSLA = profileConfig[stageName];
        if (stageSLA && stageMetrics.hasData) {
          stages[stageName] = evaluateStage(stageSLA, stageMetrics);
        }
      }
    }
  }

  // 종합 점수 계산
  const { score, grade, passed } = calculateOverallScore(items);

  // 권장사항 생성
  const recommendations = generateRecommendations(items, stages);

  // 종합 요약 생성
  const summary = generateSummary(passed, score, grade, items);

  return {
    overall: {
      passed,
      score,
      grade,
      summary,
    },
    items,
    stages,
    recommendations,
    sla,
    metadata: {
      scenario,
      profile,
      evaluatedAt: new Date().toISOString(),
      slaTolerance: SLA_TOLERANCE,
    },
  };
}

// ============================================================
// 내부 헬퍼 함수
// ============================================================

/**
 * 개별 SLA 항목 평가
 *
 * @param {string} category - 카테고리 (responseTime, errorRate 등)
 * @param {string} metric - 메트릭 이름 (p95, rate 등)
 * @param {number} slaValue - SLA 기준값
 * @param {number} actualValue - 실제 측정값
 * @param {string} unit - 단위
 * @param {boolean} higherIsBetter - 높을수록 좋은 지표 여부
 * @returns {object} 평가 결과
 */
function evaluateItem(category, metric, slaValue, actualValue, unit, higherIsBetter = false) {
  // slaValue가 0일 때 division by zero 방어
  const deviation = slaValue !== 0 ? ((actualValue - slaValue) / slaValue) * 100 : 0;
  let passed;
  let score;

  if (higherIsBetter) {
    // 높을수록 좋은 지표 (가용성, 처리량)
    passed = actualValue >= slaValue;
    score = slaValue > 0
      ? Math.min(100, Math.round((actualValue / slaValue) * 100))
      : (actualValue > 0 ? 100 : 0);
  } else {
    // 낮을수록 좋은 지표 (응답 시간, 에러율)
    // 점수 계산: SLA 이하면 50-100점, SLA 초과면 0-50점
    passed = actualValue <= slaValue;
    const ratio = slaValue > 0 ? actualValue / slaValue : 0;
    score = Math.max(0, Math.min(100, Math.round((1 - ratio) * 50 + 50)));
  }

  return {
    category,
    metric,
    slaValue,
    actualValue,
    unit,
    passed,
    score,
    deviation,
  };
}

/**
 * 단계별 평가
 *
 * @param {object} stageSLA - 단계 SLA
 * @param {object} stageMetrics - 단계 메트릭
 * @returns {object} 단계 평가 결과
 */
function evaluateStage(stageSLA, stageMetrics) {
  const items = [];

  if (stageSLA.responseTime?.p95 !== undefined) {
    items.push(evaluateItem(
      'responseTime',
      'p95',
      stageSLA.responseTime.p95,
      stageMetrics.responseP95 || 0,
      'ms'
    ));
  }

  if (stageSLA.errorRate !== undefined) {
    items.push(evaluateItem(
      'errorRate',
      'rate',
      stageSLA.errorRate,
      stageMetrics.errorRate || 0,
      '%'
    ));
  }

  const passed = items.every(item => item.passed);
  const avgScore = items.length > 0
    ? Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length)
    : 100;

  return { passed, score: avgScore, items };
}

/**
 * 종합 점수 계산
 *
 * @param {Array} items - 평가 항목 배열
 * @returns {object} { score, grade, passed }
 */
function calculateOverallScore(items) {
  if (items.length === 0) {
    return { score: 100, grade: 'A', passed: true };
  }

  // 가중치 적용 (응답 시간 P95와 에러율에 높은 가중치)
  const weights = {
    'responseTime:p95': 3,
    'responseTime:p99': 2,
    'responseTime:p50': 1,
    'errorRate:rate': 3,
    'availability:percentage': 2,
    'throughput:rps': 1,
  };

  let totalWeight = 0;
  let weightedScore = 0;

  for (const item of items) {
    const key = `${item.category}:${item.metric}`;
    const weight = weights[key] || 1;
    totalWeight += weight;
    weightedScore += item.score * weight;
  }

  const score = Math.round(weightedScore / totalWeight);
  const passed = items.every(item => item.passed);

  // 등급 계산
  let grade;
  if (score >= 90) grade = 'A';
  else if (score >= 80) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 60) grade = 'D';
  else grade = 'F';

  // pass 여부에 따라 등급 조정
  if (!passed && grade === 'A') grade = 'B';

  return { score, grade, passed };
}

/**
 * 권장사항 생성
 *
 * @param {Array} items - 평가 항목 배열
 * @param {object} stages - 단계별 평가 결과
 * @returns {Array} 권장사항 배열
 */
function generateRecommendations(items, stages) {
  const recommendations = [];

  // 실패한 항목 분석
  const failedItems = items.filter(item => !item.passed);

  for (const item of failedItems) {
    if (item.category === 'responseTime') {
      recommendations.push({
        priority: item.deviation > 50 ? 'high' : 'medium',
        message: `응답 시간 ${item.metric} 개선 필요: ${item.actualValue.toFixed(0)}ms → ${item.slaValue}ms 이하`,
      });
    } else if (item.category === 'errorRate') {
      recommendations.push({
        priority: item.deviation > 100 ? 'high' : 'medium',
        message: `에러율 개선 필요: ${item.actualValue.toFixed(2)}% → ${item.slaValue}% 이하`,
      });
    } else if (item.category === 'availability') {
      recommendations.push({
        priority: 'high',
        message: `가용성 개선 필요: ${item.actualValue.toFixed(2)}% → ${item.slaValue}% 이상`,
      });
    } else if (item.category === 'throughput') {
      recommendations.push({
        priority: item.deviation < -30 ? 'high' : 'medium',
        message: `처리량 개선 필요: ${item.actualValue.toFixed(0)} req/s → ${item.slaValue} req/s 이상`,
      });
    }
  }

  // 단계별 실패 분석
  const failedStages = Object.entries(stages).filter(([, stage]) => !stage.passed);
  if (failedStages.length > 0) {
    const stageNames = failedStages.map(([name]) => name).join(', ');
    recommendations.push({
      priority: 'medium',
      message: `다음 단계에서 SLA 미달: ${stageNames}`,
    });
  }

  // 모두 통과한 경우
  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'low',
      message: '모든 SLA 기준 충족. 현재 설정 유지 권장.',
    });
  }

  // 우선순위 순으로 정렬
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return recommendations;
}

/**
 * 종합 요약 생성
 *
 * @param {boolean} passed - 전체 통과 여부
 * @param {number} score - 종합 점수
 * @param {string} grade - 등급
 * @param {Array} items - 평가 항목 배열
 * @returns {string} 요약 문자열
 */
function generateSummary(passed, score, grade, items) {
  const passedCount = items.filter(item => item.passed).length;
  const totalCount = items.length;

  if (passed) {
    return `모든 SLA 기준 충족 (${passedCount}/${totalCount} 항목 통과, 점수: ${score}점, 등급: ${grade})`;
  }
  return `SLA 미달 (${passedCount}/${totalCount} 항목 통과, 점수: ${score}점, 등급: ${grade})`;
}

/**
 * SLA 객체 병합
 *
 * @param {object} base - 기본 SLA
 * @param {object} override - 오버라이드 SLA
 * @returns {object} 병합된 SLA
 */
function mergeSLA(base, override) {
  const result = { ...base };

  for (const key of Object.keys(override)) {
    if (typeof override[key] === 'object' && override[key] !== null && !Array.isArray(override[key])) {
      result[key] = { ...(result[key] || {}), ...override[key] };
    } else {
      result[key] = override[key];
    }
  }

  return result;
}

/**
 * SLA에 tolerance 적용 (SLA 기준 완화)
 *
 * @param {object} sla - 원본 SLA
 * @param {number} tolerance - 완화 비율 (%, 0 이상)
 * @returns {object} tolerance 적용된 SLA
 */
function applySLATolerance(sla, tolerance) {
  // 음수 tolerance는 무시 (완화만 지원)
  const safeTolerance = Math.max(0, tolerance);
  const factor = 1 + safeTolerance / 100;
  const result = { ...sla };

  // 응답 시간: 기준값 증가 (완화)
  if (result.responseTime) {
    result.responseTime = { ...result.responseTime };
    for (const key of Object.keys(result.responseTime)) {
      result.responseTime[key] = Math.ceil(result.responseTime[key] * factor);
    }
  }

  // 에러율: 기준값 증가 (완화)
  if (result.errorRate !== undefined) {
    result.errorRate = result.errorRate * factor;
  }

  // 가용성: 기준값 감소 (완화)
  if (result.availability !== undefined) {
    result.availability = Math.max(0, result.availability - safeTolerance * 0.01);
  }

  // 처리량: 기준값 감소 (완화)
  if (result.throughput !== undefined) {
    result.throughput = Math.floor(result.throughput / factor);
  }

  return result;
}

// ============================================================
// 출력 함수
// ============================================================

/**
 * SLA 평가 결과를 마크다운 형식으로 변환
 *
 * @param {object} evaluation - evaluateSLA()의 반환값
 * @returns {string} 마크다운 형식의 SLA 리포트
 */
export function formatSLAReport(evaluation) {
  const { overall, items, stages, recommendations, metadata } = evaluation;

  // 종합 판정 아이콘
  const statusIcon = overall.passed ? '✅' : '❌';
  const gradeEmoji = {
    A: '🏆',
    B: '🥈',
    C: '🥉',
    D: '⚠️',
    F: '❌',
  };

  let report = `
## 📋 SLA 평가 결과

### 종합 판정

| 항목 | 결과 |
|------|------|
| **통과 여부** | ${statusIcon} ${overall.passed ? '통과' : '미달'} |
| **점수** | ${overall.score}/100 |
| **등급** | ${gradeEmoji[overall.grade] || ''} ${overall.grade} |

> ${overall.summary}

`;

  // 항목별 평가
  if (items.length > 0) {
    report += `### 항목별 평가

| 카테고리 | 항목 | 기준 | 실제 | 점수 | 결과 |
|----------|------|------|------|------|------|
`;
    for (const item of items) {
      const icon = item.passed ? '✅' : '❌';
      const actualFormatted = item.unit === '%'
        ? `${item.actualValue.toFixed(2)}${item.unit}`
        : `${item.actualValue.toFixed(0)}${item.unit}`;
      const slaFormatted = item.unit === '%'
        ? `${item.slaValue}${item.unit}`
        : `${item.slaValue}${item.unit}`;

      report += `| ${item.category} | ${item.metric} | ${slaFormatted} | ${actualFormatted} | ${item.score} | ${icon} |\n`;
    }
    report += '\n';
  }

  // 단계별 평가 (있는 경우)
  const stageEntries = Object.entries(stages);
  if (stageEntries.length > 0) {
    report += `### 단계별 평가

| 단계 | 점수 | 결과 |
|------|------|------|
`;
    for (const [stageName, stageResult] of stageEntries) {
      const icon = stageResult.passed ? '✅' : '❌';
      report += `| ${stageName} | ${stageResult.score}/100 | ${icon} |\n`;
    }
    report += '\n';
  }

  // 권장사항
  if (recommendations.length > 0) {
    report += `### 권장사항

`;
    const priorityIcons = { high: '🔴', medium: '🟡', low: '🟢' };
    for (const rec of recommendations) {
      const icon = priorityIcons[rec.priority] || '⚪';
      report += `${icon} ${rec.message}\n\n`;
    }
  }

  // 메타데이터
  report += `---

*SLA 평가 시각: ${metadata.evaluatedAt}*
*시나리오: ${metadata.scenario}, 프로파일: ${metadata.profile}${metadata.slaTolerance > 0 ? `, Tolerance: ${metadata.slaTolerance}%` : ''}*
`;

  return report;
}

/**
 * SLA 평가 결과를 JSON 형식으로 내보내기
 *
 * @param {object} evaluation - evaluateSLA()의 반환값
 * @returns {string} JSON 문자열
 */
export function exportSLAResult(evaluation) {
  return JSON.stringify({
    overall: evaluation.overall,
    items: evaluation.items.map(item => ({
      category: item.category,
      metric: item.metric,
      slaValue: item.slaValue,
      actualValue: item.actualValue,
      unit: item.unit,
      passed: item.passed,
      score: item.score,
    })),
    stages: evaluation.stages,
    recommendations: evaluation.recommendations,
    metadata: evaluation.metadata,
  }, null, 2);
}
