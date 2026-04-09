import fs from 'node:fs';
import path from 'node:path';
import { ChatbotClient } from './client/chatbotClient';
import { loadConfig } from './config';
import { computeScenarioMetrics, EvaluatedResult } from './metrics';
import { validateResult } from './validator';
import { appendJsonl, ensureDir, writeJson } from './utils/fs';
import { BreakpointStepMetrics, HarnessConfig, ScenarioDefinition, ScenarioMetrics } from './types';
import { buildScenarios, profileOverrides } from '../scenarios';

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function runScenario(client: ChatbotClient, scenario: ScenarioDefinition): Promise<EvaluatedResult[]> {
  const batches = chunkArray(scenario.requests, Math.max(1, scenario.concurrency));
  const results: EvaluatedResult[] = [];

  for (const batch of batches) {
    const settled = await Promise.all(batch.map((payload) => client.send(payload, scenario.name, scenario.timeoutMs)));
    for (const result of settled) {
      results.push({ result, validation: validateResult(result, scenario.validation) });
    }
  }

  return results;
}

function aggregateSummary(metrics: ScenarioMetrics[]) {
  const totals = metrics.reduce(
    (acc, item) => {
      acc.total += item.total;
      acc.failures += item.failures;
      acc.warns += item.warns;
      acc.timeouts += item.timeoutCount;
      acc.non200 += item.non200Count;
      acc.parseFailures += item.parseFailureCount;
      acc.empty += item.emptyResponseCount;
      acc.schemaDrift += item.schemaDriftCount;
      return acc;
    },
    { total: 0, failures: 0, warns: 0, timeouts: 0, non200: 0, parseFailures: 0, empty: 0, schemaDrift: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    totals,
    successRate: totals.total ? (totals.total - totals.failures) / totals.total : 0,
    scenarios: metrics.length,
    scenarioFailureSummary: metrics.map((m) => ({ scenario: m.name, failures: m.failures, warns: m.warns })),
  };
}

function writeHumanHtml(outputDir: string, summary: ReturnType<typeof aggregateSummary>, metrics: ScenarioMetrics[]): void {
  const rows = metrics
    .map((m) => `<tr><td>${m.name}</td><td>${m.total}</td><td>${(m.successRate * 100).toFixed(1)}%</td><td>${m.p95}</td><td>${m.timeoutCount}</td><td>${m.non200Count}</td><td>${m.warns}</td><td>${m.failures}</td></tr>`)
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>Chatbot Stress Report</title>
<style>body{font-family:Arial,sans-serif;padding:20px;} table{border-collapse:collapse;width:100%;} td,th{border:1px solid #ddd;padding:8px;} th{background:#f4f4f4;}</style>
</head><body>
<h1>Chatbot Stress Summary</h1>
<p>Generated at: ${summary.generatedAt}</p>
<p>Success rate: ${(summary.successRate * 100).toFixed(2)}%</p>
<table><thead><tr><th>Scenario</th><th>Total</th><th>Success</th><th>p95 (ms)</th><th>Timeouts</th><th>Non-200</th><th>Warn</th><th>Fail</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;

  fs.writeFileSync(path.join(outputDir, 'report.html'), html, 'utf8');
}

function writeCsv(outputDir: string, metrics: ScenarioMetrics[]): void {
  const header = 'scenario,total,success_rate,p50,p95,p99,timeouts,non200,parse_failures,empty,schema_drift,dup_ratio,answer_len_avg,warns,failures';
  const rows = metrics.map((m) =>
    [
      m.name,
      m.total,
      m.successRate,
      m.p50,
      m.p95,
      m.p99,
      m.timeoutCount,
      m.non200Count,
      m.parseFailureCount,
      m.emptyResponseCount,
      m.schemaDriftCount,
      m.duplicateResponseRatio,
      m.answerLengthAvg,
      m.warns,
      m.failures,
    ].join(','),
  );
  fs.writeFileSync(path.join(outputDir, 'scenario-metrics.csv'), [header, ...rows].join('\n'), 'utf8');
}

function evaluateBreakpointStep(metrics: ScenarioMetrics, concurrency: number, config: HarnessConfig): BreakpointStepMetrics {
  const total = Math.max(1, metrics.total);
  const timeoutRate = metrics.timeoutCount / total;
  const errorRate = metrics.non200Count / total;
  const emptyResponseRate = metrics.emptyResponseCount / total;
  const schemaDriftRate = metrics.schemaDriftCount / total;

  const violations: string[] = [];
  if (metrics.p95 > config.breakpointThresholds.maxP95LatencyMs) {
    violations.push(`p95 latency ${metrics.p95}ms > ${config.breakpointThresholds.maxP95LatencyMs}ms`);
  }
  if (timeoutRate > config.breakpointThresholds.maxTimeoutRate) {
    violations.push(`timeout rate ${(timeoutRate * 100).toFixed(2)}% > ${(config.breakpointThresholds.maxTimeoutRate * 100).toFixed(2)}%`);
  }
  if (errorRate > config.breakpointThresholds.maxErrorRate) {
    violations.push(`error rate ${(errorRate * 100).toFixed(2)}% > ${(config.breakpointThresholds.maxErrorRate * 100).toFixed(2)}%`);
  }
  if (emptyResponseRate > config.breakpointThresholds.maxEmptyResponseRate) {
    violations.push(`empty response rate ${(emptyResponseRate * 100).toFixed(2)}% > ${(config.breakpointThresholds.maxEmptyResponseRate * 100).toFixed(2)}%`);
  }
  if (schemaDriftRate > config.breakpointThresholds.maxSchemaDriftRate) {
    violations.push(`schema drift rate ${(schemaDriftRate * 100).toFixed(2)}% > ${(config.breakpointThresholds.maxSchemaDriftRate * 100).toFixed(2)}%`);
  }

  return {
    concurrency,
    total,
    p95LatencyMs: metrics.p95,
    timeoutRate,
    errorRate,
    emptyResponseRate,
    schemaDriftRate,
    healthy: violations.length === 0,
    violations,
  };
}

function buildBreakpointMarkdown(steps: BreakpointStepMetrics[], bestStableConcurrency: number, firstUnstableConcurrency: number | null): string {
  const healthy = steps.filter((s) => s.healthy);
  const degrading = steps.filter((s) => !s.healthy && s.violations.length <= 2);
  const unreliable = steps.filter((s) => !s.healthy && s.violations.length > 2);

  const rows = steps
    .map((s) => `| ${s.concurrency} | ${s.total} | ${s.p95LatencyMs} | ${(s.timeoutRate * 100).toFixed(2)}% | ${(s.errorRate * 100).toFixed(2)}% | ${(s.emptyResponseRate * 100).toFixed(2)}% | ${(s.schemaDriftRate * 100).toFixed(2)}% | ${s.healthy ? 'Healthy' : `Unstable: ${s.violations.join('; ')}`} |`)
    .join('\n');

  const healthyText = healthy.length
    ? `Il sistema appare **sano** fino a concorrenza ${bestStableConcurrency}, con metriche sotto soglia.`
    : 'Il sistema non mostra una fascia chiaramente sana nelle misurazioni eseguite.';

  const degradingText = degrading.length
    ? `La degradazione inizia a emergere a partire da concorrenza ${degrading[0].concurrency}, con violazioni moderate.`
    : 'Non sono state osservate fasi di degradazione graduale prima dell\'instabilità forte.';

  const unreliableText = firstUnstableConcurrency !== null
    ? `Il sistema diventa **inaffidabile** da concorrenza ${firstUnstableConcurrency} in poi (prima soglia SLA violata).`
    : 'Non è stato rilevato un punto di instabilità nelle soglie configurate.';

  return [
    '# Breakpoint Discovery Summary',
    '',
    '## Interpretazione',
    `- ${healthyText}`,
    `- ${degradingText}`,
    `- ${unreliableText}`,
    '',
    '## Stima operativa',
    `- **Best stable concurrency:** ${bestStableConcurrency}`,
    `- **First unstable concurrency:** ${firstUnstableConcurrency ?? 'non rilevata'}`,
    '',
    '## Tabella per step',
    '| Concurrency | Requests | p95 (ms) | Timeout rate | Error rate | Empty rate | Schema drift rate | Stato |',
    '|---:|---:|---:|---:|---:|---:|---:|---|',
    rows,
    '',
  ].join('\n');
}

async function runBreakpointSearch(baseConfig: HarnessConfig): Promise<{
  steps: BreakpointStepMetrics[];
  bestStableConcurrency: number;
  firstUnstableConcurrency: number | null;
}> {
  const steps: BreakpointStepMetrics[] = [];
  const stepSize = Math.max(1, Math.floor(baseConfig.maxConcurrency / baseConfig.rampSteps));
  let bestStableConcurrency = 0;
  let firstUnstableConcurrency: number | null = null;

  for (let concurrency = 1; concurrency <= baseConfig.maxConcurrency; concurrency += stepSize) {
    const iterationConfig = { ...baseConfig, maxConcurrency: concurrency };
    const client = new ChatbotClient(iterationConfig);
    const requests = Array.from({ length: Math.max(50, Math.floor(baseConfig.totalRequests / 2)) }, (_, i) => ({
      input: `Breakpoint probe #${i}: descrivi sicurezza pneumatici in 2 frasi.`,
    }));

    const scenario: ScenarioDefinition = {
      name: `breakpoint-${concurrency}`,
      requests,
      concurrency,
      validation: { mode: 'non_empty' },
    };

    const evaluated = await runScenario(client, scenario);
    const metrics = computeScenarioMetrics(scenario.name, evaluated);
    const stepMetrics = evaluateBreakpointStep(metrics, concurrency, baseConfig);
    steps.push(stepMetrics);

    if (stepMetrics.healthy) {
      bestStableConcurrency = concurrency;
      continue;
    }

    firstUnstableConcurrency = concurrency;
    break;
  }

  return { steps, bestStableConcurrency, firstUnstableConcurrency };
}

export async function runHarness(): Promise<void> {
  const loaded = loadConfig();
  const config: HarnessConfig = { ...loaded, ...profileOverrides(loaded) };
  ensureDir(config.outputDir);

  const client = new ChatbotClient(config);
  const scenarios = buildScenarios(config);

  const metrics: ScenarioMetrics[] = [];

  for (const scenario of scenarios) {
    const rows = await runScenario(client, scenario);
    for (const row of rows) {
      const hardFail = row.validation.score === 'fail' || row.result.error || row.result.timedOut || (row.result.status ?? 0) !== 200;
      const shouldStore = hardFail || row.validation.score === 'warn';

      if (shouldStore) {
        appendJsonl(path.join(config.outputDir, 'failures.jsonl'), {
          requestId: row.result.requestId,
          scenario: row.result.scenario,
          status: row.result.status,
          latencyMs: row.result.latencyMs,
          error: row.result.error,
          score: row.validation.score,
          knownFlakySemantic: row.validation.knownFlakySemantic,
          validation: row.validation,
          rawBody: row.result.rawBody,
        });
      }
    }

    metrics.push(computeScenarioMetrics(scenario.name, rows));
  }

  const breakpoint = config.profile === 'breakpoint'
    ? await runBreakpointSearch(config)
    : { steps: [], bestStableConcurrency: 0, firstUnstableConcurrency: null };

  const summary = aggregateSummary(metrics);
  const breakpointMarkdown = breakpoint.steps.length
    ? buildBreakpointMarkdown(breakpoint.steps, breakpoint.bestStableConcurrency, breakpoint.firstUnstableConcurrency)
    : '';

  writeJson(path.join(config.outputDir, 'summary.json'), { ...summary, breakpoint });
  writeJson(path.join(config.outputDir, 'scenario-metrics.json'), metrics);
  writeCsv(config.outputDir, metrics);
  writeHumanHtml(config.outputDir, summary, metrics);

  if (breakpoint.steps.length) {
    writeJson(path.join(config.outputDir, 'breakpoint-summary.json'), breakpoint);
    writeJson(path.join(config.outputDir, 'breakpoint-steps.json'), breakpoint.steps);
    fs.writeFileSync(path.join(config.outputDir, 'breakpoint-summary.md'), breakpointMarkdown, 'utf8');
  }

  console.log('=== Chatbot Stress Summary ===');
  console.log(`Profile: ${config.profile}`);
  console.log(`Total requests: ${summary.totals.total}`);
  console.log(`Success rate: ${(summary.successRate * 100).toFixed(2)}%`);
  console.log(`Warn count: ${summary.totals.warns}`);
  console.log(`Hard failures: ${summary.totals.failures}`);
  console.log(`Timeouts: ${summary.totals.timeouts}`);
  console.log(`Non-200: ${summary.totals.non200}`);

  if (breakpoint.steps.length) {
    console.log('=== Breakpoint Discovery ===');
    console.log(`Best stable concurrency: ${breakpoint.bestStableConcurrency}`);
    console.log(`First unstable concurrency: ${breakpoint.firstUnstableConcurrency ?? 'not reached'}`);
    console.log(`Interpretation file: ${path.join(config.outputDir, 'breakpoint-summary.md')}`);
  }
}
