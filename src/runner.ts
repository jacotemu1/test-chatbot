import fs from 'node:fs';
import path from 'node:path';
import { ChatbotClient } from './client/chatbotClient';
import { loadConfig } from './config';
import { computeScenarioMetrics, EvaluatedResult } from './metrics';
import { validateResult } from './validator';
import { appendJsonl, ensureDir, writeJson } from './utils/fs';
import {
  BreakpointStepMetrics,
  ConversationRunMetrics,
  ConversationScenario,
  HarnessConfig,
  ScenarioDefinition,
  ScenarioMetrics,
} from './types';
import { buildScenarios, profileOverrides } from '../scenarios';
import { buildConversationScenarios } from '../scenarios/conversations';

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

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function runConversationMetrics(scenario: ConversationScenario, turns: Array<{ turnId: string; answer: string; latencyMs: number; ok: boolean }>): ConversationRunMetrics {
  const byTurn = new Map(turns.map((t) => [t.turnId, t]));
  let consistencyViolations = 0;
  let memoryFailures = 0;
  let unstableRephraseCount = 0;

  const rephraseBuckets = new Map<string, string[]>();
  for (const scriptedTurn of scenario.turns) {
    const observed = byTurn.get(scriptedTurn.id);
    if (!observed) continue;

    if (scriptedTurn.expectKeywords && scriptedTurn.expectKeywords.length > 0) {
      if (!hasKeyword(observed.answer, scriptedTurn.expectKeywords)) {
        memoryFailures += 1;
      }
    }

    if (scriptedTurn.memoryCheckForTurnId) {
      const referenced = byTurn.get(scriptedTurn.memoryCheckForTurnId);
      if (referenced && scriptedTurn.expectKeywords && !hasKeyword(observed.answer, scriptedTurn.expectKeywords)) {
        memoryFailures += 1;
      }
    }

    if (scriptedTurn.contradictionWithTurnId) {
      const prior = byTurn.get(scriptedTurn.contradictionWithTurnId);
      if (prior && normalize(prior.answer) === normalize(observed.answer)) {
        consistencyViolations += 1;
      }
    }

    if (scriptedTurn.rephraseGroup) {
      const bucket = rephraseBuckets.get(scriptedTurn.rephraseGroup) ?? [];
      bucket.push(normalize(observed.answer));
      rephraseBuckets.set(scriptedTurn.rephraseGroup, bucket);
    }
  }

  for (const answers of rephraseBuckets.values()) {
    if (answers.length >= 2) {
      const unique = new Set(answers);
      if (unique.size === answers.length) unstableRephraseCount += 1;
    }
  }

  const turnLatenciesMs = turns.map((t) => t.latencyMs);
  const completedTurns = turns.filter((t) => t.ok).length;
  const completionRate = scenario.turns.length ? completedTurns / scenario.turns.length : 0;
  const avgTurnLatencyMs = turnLatenciesMs.length
    ? turnLatenciesMs.reduce((a, b) => a + b, 0) / turnLatenciesMs.length
    : 0;

  const split = Math.max(1, Math.floor(turnLatenciesMs.length * 0.3));
  const early = turnLatenciesMs.slice(0, split);
  const late = turnLatenciesMs.slice(-split);
  const earlyAvg = early.length ? early.reduce((a, b) => a + b, 0) / early.length : 1;
  const lateAvg = late.length ? late.reduce((a, b) => a + b, 0) / late.length : earlyAvg;
  const lateTurnLatencyGrowthRatio = earlyAvg > 0 ? lateAvg / earlyAvg : 1;

  return {
    scenario: scenario.name,
    totalTurns: scenario.turns.length,
    completedTurns,
    completionRate,
    turnLatenciesMs,
    avgTurnLatencyMs,
    lateTurnLatencyGrowthRatio,
    consistencyViolations,
    memoryFailures,
    unstableRephraseCount,
  };
}

async function runConversationScenario(client: ChatbotClient, scenario: ConversationScenario): Promise<ConversationRunMetrics> {
  const history: Array<{ role: string; content: string }> = [];
  const turns: Array<{ turnId: string; answer: string; latencyMs: number; ok: boolean }> = [];

  for (const turn of scenario.turns) {
    const result = await client.send({ input: turn.userPrompt, context: history }, `conversation-${scenario.name}`);
    const validation = validateResult(result, { mode: 'consistency_check', expectedKeywords: turn.expectKeywords });
    const answer = validation.answerText ?? result.rawBody ?? '';

    turns.push({
      turnId: turn.id,
      answer,
      latencyMs: result.latencyMs,
      ok: !result.error && !result.timedOut && (result.status ?? 0) === 200 && validation.score !== 'fail',
    });

    history.push({ role: 'user', content: turn.userPrompt });
    history.push({ role: 'assistant', content: answer || '[empty]' });
  }

  return runConversationMetrics(scenario, turns);
}

function writeConversationMarkdown(outputDir: string, items: ConversationRunMetrics[]): void {
  const rows = items
    .map((m) => `| ${m.scenario} | ${(m.completionRate * 100).toFixed(1)}% | ${m.avgTurnLatencyMs.toFixed(0)} | ${m.lateTurnLatencyGrowthRatio.toFixed(2)}x | ${m.consistencyViolations} | ${m.memoryFailures} | ${m.unstableRephraseCount} |`)
    .join('\n');

  const healthy = items.filter((m) => m.completionRate >= 0.95 && m.consistencyViolations === 0 && m.memoryFailures === 0);
  const degrading = items.filter((m) => m.lateTurnLatencyGrowthRatio > 1.2 || m.unstableRephraseCount > 0);
  const unreliable = items.filter((m) => m.completionRate < 0.9 || m.consistencyViolations > 0 || m.memoryFailures > 0);

  const md = [
    '# Conversation Session Summary',
    '',
    '## Interpretazione',
    `- **Healthy**: ${healthy.map((x) => x.scenario).join(', ') || 'nessuno scenario chiaramente sano'}.`,
    `- **Starts degrading**: ${degrading.map((x) => x.scenario).join(', ') || 'non rilevato'}.`,
    `- **Unreliable**: ${unreliable.map((x) => x.scenario).join(', ') || 'non rilevato'}.`,
    '',
    '## Tabella metriche conversazionali',
    '| Scenario | Completion rate | Avg turn latency (ms) | Late-turn growth | Consistency violations | Memory failures | Rephrase instability |',
    '|---|---:|---:|---:|---:|---:|---:|',
    rows,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(outputDir, 'conversation-summary.md'), md, 'utf8');
}

function buildDashboardHtml(data: unknown): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Chatbot Stress Dashboard</title>
  <style>
    body{font-family:Arial,sans-serif;margin:20px;background:#fafafa;color:#111}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
    .card{background:#fff;padding:12px;border:1px solid #ddd;border-radius:8px}
    table{width:100%;border-collapse:collapse;background:#fff;margin:10px 0}
    th,td{border:1px solid #ddd;padding:8px;text-align:left;font-size:13px}
    th{background:#f1f1f1}
    h2{margin-top:24px}
    .muted{color:#666;font-size:12px}
    .bar{height:8px;background:#e6e6e6;border-radius:4px;overflow:hidden}
    .fill{height:100%;background:#db3b3b}
    details{background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;margin:8px 0}
    code{white-space:pre-wrap;display:block}
  </style>
</head>
<body>
  <h1>Chatbot Stress Dashboard</h1>
  <div id="app"></div>
  <script>
    const data = ${JSON.stringify(data)};

    function pct(v){ return (v*100).toFixed(2)+'%'; }
    function esc(s){ return String(s ?? ''); }

    const app = document.getElementById('app');
    const cards = [
      ['Total requests', data.summary?.totals?.total ?? 0],
      ['Success rate', pct(data.summary?.successRate ?? 0)],
      ['Hard failures', data.summary?.totals?.failures ?? 0],
      ['Timeouts', data.summary?.totals?.timeouts ?? 0],
      ['Warns', data.summary?.totals?.warns ?? 0],
      ['Scenarios', data.summary?.scenarios ?? 0],
    ];

    let trendHtml = '<p class="muted">No previous run baseline found.</p>';
    if (data.previousSummary) {
      const srDelta = (data.summary.successRate - data.previousSummary.successRate) * 100;
      trendHtml = `<p><b>Trend vs previous:</b> Success rate delta: ${srDelta.toFixed(2)} pp</p>`;
    }

    const latency = data.latency;

    const errorRows = (data.scenarioMetrics || []).map(m => {
      const total = Math.max(1, m.total);
      const failRate = m.failures / total;
      return `<tr>
        <td>${esc(m.name)}</td>
        <td>${m.total}</td>
        <td>${m.failures}</td>
        <td>${m.timeoutCount}</td>
        <td>${m.non200Count}</td>
        <td>${m.schemaDriftCount}</td>
        <td>${pct(failRate)}</td>
      </tr>`;
    }).join('');

    const worstRows = (data.worstScenarios || []).map(w => {
      const total = Math.max(1, w.total);
      const failRate = w.failures / total;
      return `<tr>
        <td>${esc(w.name)}</td>
        <td>${w.failures}/${w.total}</td>
        <td><div class="bar"><div class="fill" style="width:${Math.min(100, failRate*100)}%"></div></div> ${pct(failRate)}</td>
      </tr>`;
    }).join('');

    const suspiciousRows = (data.suspicious || []).map(x => `<tr><td>${esc(x.scenario)}</td><td>${esc(x.score)}</td><td>${esc(x.reason)}</td><td>${esc(x.excerpt)}</td></tr>`).join('');

    const concurrencyRows = (data.concurrencyVsFailure || []).map(x => `<tr><td>${x.concurrency}</td><td>${pct(x.failureRate)}</td><td>${esc(x.status)}</td></tr>`).join('');

    const artifactLinks = (data.artifactLinks || []).map(x => `<li><a href="${x.href}">${x.name}</a></li>`).join('');

    app.innerHTML = `
      <div class="cards">${cards.map(c=>`<div class="card"><div class="muted">${c[0]}</div><div><b>${c[1]}</b></div></div>`).join('')}</div>
      ${trendHtml}

      <h2>Latency percentiles</h2>
      <table><tr><th>p50</th><th>p95</th><th>p99</th></tr><tr><td>${latency.p50}</td><td>${latency.p95}</td><td>${latency.p99}</td></tr></table>

      <h2>Error breakdown by scenario</h2>
      <table><tr><th>Scenario</th><th>Total</th><th>Failures</th><th>Timeouts</th><th>Non-200</th><th>Schema drift</th><th>Failure rate</th></tr>${errorRows}</table>

      <h2>Concurrency vs failure rate</h2>
      <table><tr><th>Concurrency</th><th>Failure rate</th><th>Status</th></tr>${concurrencyRows || '<tr><td colspan="3">Available after breakpoint profile run.</td></tr>'}</table>

      <h2>Worst scenarios</h2>
      <table><tr><th>Scenario</th><th>Failures</th><th>Rate</th></tr>${worstRows}</table>

      <h2>Suspicious outputs</h2>
      <table><tr><th>Scenario</th><th>Score</th><th>Reason</th><th>Excerpt</th></tr>${suspiciousRows || '<tr><td colspan="4">No suspicious outputs captured.</td></tr>'}</table>

      <h2>Artifacts</h2>
      <ul>${artifactLinks}</ul>

      <h2>Embedded excerpts</h2>
      <details><summary>summary.json</summary><code>${esc(JSON.stringify(data.summary, null, 2))}</code></details>
      <details><summary>first suspicious record</summary><code>${esc(JSON.stringify((data.suspiciousRaw||[])[0] || {}, null, 2))}</code></details>
    `;
  </script>
</body>
</html>`;
}

function writeDashboard(outputDir: string, summary: ReturnType<typeof aggregateSummary>, scenarioMetrics: ScenarioMetrics[], breakpointSteps: BreakpointStepMetrics[]): void {
  const previousSummaryPath = path.join(outputDir, 'previous-summary.json');
  const previousSummary = fs.existsSync(previousSummaryPath)
    ? JSON.parse(fs.readFileSync(previousSummaryPath, 'utf8'))
    : null;

  const failuresPath = path.join(outputDir, 'failures.jsonl');
  const failureRows = fs.existsSync(failuresPath)
    ? fs.readFileSync(failuresPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];

  const suspicious = failureRows
    .filter((x) => x.validation?.suspiciousReason || (x.validation?.suspiciousSignals || []).length > 0)
    .slice(0, 15)
    .map((x) => ({
      scenario: x.scenario,
      score: x.score,
      reason: x.validation?.suspiciousReason || (x.validation?.suspiciousSignals || []).join('; '),
      excerpt: String(x.rawBody || '').slice(0, 200),
    }));

  const weighted = scenarioMetrics.reduce((acc, m) => {
    acc.total += m.total;
    acc.p50 += m.p50 * m.total;
    acc.p95 += m.p95 * m.total;
    acc.p99 += m.p99 * m.total;
    return acc;
  }, { total: 0, p50: 0, p95: 0, p99: 0 });

  const latency = weighted.total
    ? {
        p50: Math.round(weighted.p50 / weighted.total),
        p95: Math.round(weighted.p95 / weighted.total),
        p99: Math.round(weighted.p99 / weighted.total),
      }
    : { p50: 0, p95: 0, p99: 0 };

  const worstScenarios = [...scenarioMetrics]
    .sort((a, b) => (b.failures / Math.max(1, b.total)) - (a.failures / Math.max(1, a.total)))
    .slice(0, 5);

  const concurrencyVsFailure = breakpointSteps.map((s) => ({
    concurrency: s.concurrency,
    failureRate: s.timeoutRate + s.errorRate + s.emptyResponseRate + s.schemaDriftRate,
    status: s.healthy ? 'Healthy' : 'Unstable',
  }));

  const artifactLinks = [
    'summary.json',
    'scenario-metrics.json',
    'conversation-metrics.json',
    'failures.jsonl',
    'report.html',
    'conversation-summary.md',
    'breakpoint-summary.json',
    'breakpoint-summary.md',
  ].map((name) => ({ name, href: name }));

  const dashboardData = {
    summary,
    previousSummary,
    latency,
    scenarioMetrics,
    worstScenarios,
    suspicious,
    suspiciousRaw: failureRows,
    concurrencyVsFailure,
    artifactLinks,
  };

  fs.writeFileSync(path.join(outputDir, 'dashboard.html'), buildDashboardHtml(dashboardData), 'utf8');
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

async function runBreakpointSearch(baseConfig: HarnessConfig): Promise<{ steps: BreakpointStepMetrics[]; bestStableConcurrency: number; firstUnstableConcurrency: number | null; }> {
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
  const conversationScenarios = buildConversationScenarios();

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

  const conversationMetrics: ConversationRunMetrics[] = [];
  for (const convScenario of conversationScenarios) {
    const run = await runConversationScenario(client, convScenario);
    conversationMetrics.push(run);
  }

  const breakpoint = config.profile === 'breakpoint'
    ? await runBreakpointSearch(config)
    : { steps: [], bestStableConcurrency: 0, firstUnstableConcurrency: null };

  const summary = aggregateSummary(metrics);
  const breakpointMarkdown = breakpoint.steps.length
    ? buildBreakpointMarkdown(breakpoint.steps, breakpoint.bestStableConcurrency, breakpoint.firstUnstableConcurrency)
    : '';

  writeJson(path.join(config.outputDir, 'summary.json'), { ...summary, conversationScenarios: conversationMetrics.length, breakpoint });
  writeJson(path.join(config.outputDir, 'scenario-metrics.json'), metrics);
  writeJson(path.join(config.outputDir, 'conversation-metrics.json'), conversationMetrics);
  writeCsv(config.outputDir, metrics);
  writeHumanHtml(config.outputDir, summary, metrics);
  writeConversationMarkdown(config.outputDir, conversationMetrics);
  writeDashboard(config.outputDir, summary, metrics, breakpoint.steps);

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
  console.log(`Conversation scenarios: ${conversationMetrics.length}`);
  console.log(`Dashboard: ${path.join(config.outputDir, 'dashboard.html')}`);

  if (breakpoint.steps.length) {
    console.log('=== Breakpoint Discovery ===');
    console.log(`Best stable concurrency: ${breakpoint.bestStableConcurrency}`);
    console.log(`First unstable concurrency: ${breakpoint.firstUnstableConcurrency ?? 'not reached'}`);
    console.log(`Interpretation file: ${path.join(config.outputDir, 'breakpoint-summary.md')}`);
  }
}
