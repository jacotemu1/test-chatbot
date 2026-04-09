import { ChatResult, ScenarioMetrics, ValidationOutcome } from './types';

export interface EvaluatedResult {
  result: ChatResult;
  validation: ValidationOutcome;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

export function computeScenarioMetrics(name: string, rows: EvaluatedResult[]): ScenarioMetrics {
  const latencies = rows.map((x) => x.result.latencyMs);
  const timeouts = rows.filter((x) => x.result.timedOut).length;
  const non200 = rows.filter((x) => (x.result.status ?? 0) !== 200).length;
  const parseFailure = rows.filter((x) => x.validation.parseFailure).length;
  const emptyResponse = rows.filter((x) => x.validation.emptyResponse).length;
  const schemaDrift = rows.filter((x) => x.validation.schemaDrift).length;
  const failures = rows.filter((x) => x.result.error || x.result.timedOut || (x.result.status ?? 500) !== 200).length;
  const successRate = rows.length ? (rows.length - failures) / rows.length : 0;

  const answerLengths = rows.map((x) => x.validation.answerText?.length ?? 0);
  const answerLengthAvg = answerLengths.length
    ? answerLengths.reduce((a, b) => a + b, 0) / answerLengths.length
    : 0;

  const answerTextList = rows.map((x) => x.validation.answerText ?? '').filter(Boolean);
  const duplicates = answerTextList.length - new Set(answerTextList).size;
  const duplicateResponseRatio = answerTextList.length ? duplicates / answerTextList.length : 0;

  return {
    name,
    total: rows.length,
    successRate,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    timeoutCount: timeouts,
    non200Count: non200,
    parseFailureCount: parseFailure,
    emptyResponseCount: emptyResponse,
    schemaDriftCount: schemaDrift,
    duplicateResponseRatio,
    answerLengthAvg,
    failures,
  };
}
