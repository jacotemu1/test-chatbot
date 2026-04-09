import fs from 'node:fs';
import path from 'node:path';
import { ChatbotClient } from './client/chatbotClient';
import { loadConfig } from './config';
import { computeScenarioMetrics, EvaluatedResult } from './metrics';
import { evaluateSalesSignals } from './salesEvaluator';
import { validateResult } from './validator';
import { appendJsonl, ensureDir, writeJson } from './utils/fs';
import { BreakpointStepMetrics, ConversationRunMetrics, ConversationScenario, HarnessConfig, ScenarioDefinition, ScenarioMetrics } from './types';
import { buildScenarios, profileOverrides } from '../scenarios';
import { buildConversationScenarios } from '../scenarios/conversations';

type ScenarioRow = EvaluatedResult & { prompt: string; salesSignals: ReturnType<typeof evaluateSalesSignals> };

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function runScenario(client: ChatbotClient, scenario: ScenarioDefinition): Promise<ScenarioRow[]> {
  const batches = chunkArray(scenario.requests, Math.max(1, scenario.concurrency));
  const results: ScenarioRow[] = [];

  for (const batch of batches) {
    const settled = await Promise.all(batch.map((payload) => client.send(payload, scenario.name, scenario.timeoutMs)));
    settled.forEach((result, idx) => {
      const prompt = String(batch[idx].input ?? '');
      const validation = validateResult(result, scenario.validation);
      const answerText = validation.answerText ?? result.rawBody ?? '';
      results.push({ result, validation, prompt, salesSignals: evaluateSalesSignals(prompt, answerText) });
    });
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
  };
}

function writeCsv(outputDir: string, metrics: ScenarioMetrics[]): void {
  const header = 'scenario,total,success_rate,p50,p95,p99,timeouts,non200,parse_failures,empty,schema_drift,dup_ratio,answer_len_avg,warns,failures';
  const rows = metrics.map((m) => [m.name,m.total,m.successRate,m.p50,m.p95,m.p99,m.timeoutCount,m.non200Count,m.parseFailureCount,m.emptyResponseCount,m.schemaDriftCount,m.duplicateResponseRatio,m.answerLengthAvg,m.warns,m.failures].join(','));
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

    if (scriptedTurn.expectKeywords && scriptedTurn.expectKeywords.length > 0 && !hasKeyword(observed.answer, scriptedTurn.expectKeywords)) {
      memoryFailures += 1;
    }

    if (scriptedTurn.contradictionWithTurnId) {
      const prior = byTurn.get(scriptedTurn.contradictionWithTurnId);
      if (prior && normalize(prior.answer) === normalize(observed.answer)) consistencyViolations += 1;
    }

    if (scriptedTurn.rephraseGroup) {
      const bucket = rephraseBuckets.get(scriptedTurn.rephraseGroup) ?? [];
      bucket.push(normalize(observed.answer));
      rephraseBuckets.set(scriptedTurn.rephraseGroup, bucket);
    }
  }

  for (const answers of rephraseBuckets.values()) {
    if (answers.length >= 2 && new Set(answers).size === answers.length) unstableRephraseCount += 1;
  }

  const turnLatenciesMs = turns.map((t) => t.latencyMs);
  const completedTurns = turns.filter((t) => t.ok).length;
  const completionRate = scenario.turns.length ? completedTurns / scenario.turns.length : 0;
  const avgTurnLatencyMs = turnLatenciesMs.length ? turnLatenciesMs.reduce((a, b) => a + b, 0) / turnLatenciesMs.length : 0;
  const split = Math.max(1, Math.floor(turnLatenciesMs.length * 0.3));
  const earlyAvg = turnLatenciesMs.slice(0, split).reduce((a, b) => a + b, 0) / split;
  const lateAvg = turnLatenciesMs.slice(-split).reduce((a, b) => a + b, 0) / split;

  return {
    scenario: scenario.name,
    totalTurns: scenario.turns.length,
    completedTurns,
    completionRate,
    turnLatenciesMs,
    avgTurnLatencyMs,
    lateTurnLatencyGrowthRatio: earlyAvg > 0 ? lateAvg / earlyAvg : 1,
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
    turns.push({ turnId: turn.id, answer, latencyMs: result.latencyMs, ok: !result.error && !result.timedOut && (result.status ?? 0) === 200 && validation.score !== 'fail' });
    history.push({ role: 'user', content: turn.userPrompt });
    history.push({ role: 'assistant', content: answer || '[empty]' });
  }

  return runConversationMetrics(scenario, turns);
}

function evaluateBreakpointStep(metrics: ScenarioMetrics, concurrency: number, config: HarnessConfig): BreakpointStepMetrics {
  const total = Math.max(1, metrics.total);
  const timeoutRate = metrics.timeoutCount / total;
  const errorRate = metrics.non200Count / total;
  const emptyResponseRate = metrics.emptyResponseCount / total;
  const schemaDriftRate = metrics.schemaDriftCount / total;

  const violations: string[] = [];
  if (metrics.p95 > config.breakpointThresholds.maxP95LatencyMs) violations.push('p95 latency');
  if (timeoutRate > config.breakpointThresholds.maxTimeoutRate) violations.push('timeout rate');
  if (errorRate > config.breakpointThresholds.maxErrorRate) violations.push('error rate');
  if (emptyResponseRate > config.breakpointThresholds.maxEmptyResponseRate) violations.push('empty response rate');
  if (schemaDriftRate > config.breakpointThresholds.maxSchemaDriftRate) violations.push('schema drift rate');

  return { concurrency, total, p95LatencyMs: metrics.p95, timeoutRate, errorRate, emptyResponseRate, schemaDriftRate, healthy: violations.length === 0, violations };
}

async function runBreakpointSearch(baseConfig: HarnessConfig): Promise<{ steps: BreakpointStepMetrics[]; bestStableConcurrency: number; firstUnstableConcurrency: number | null; }> {
  const steps: BreakpointStepMetrics[] = [];
  const stepSize = Math.max(1, Math.floor(baseConfig.maxConcurrency / baseConfig.rampSteps));
  let bestStableConcurrency = 0;
  let firstUnstableConcurrency: number | null = null;

  for (let concurrency = 1; concurrency <= baseConfig.maxConcurrency; concurrency += stepSize) {
    const client = new ChatbotClient({ ...baseConfig, maxConcurrency: concurrency });
    const requests = Array.from({ length: Math.max(50, Math.floor(baseConfig.totalRequests / 2)) }, (_, i) => ({ input: `Breakpoint probe #${i}: consiglio gomme con sicurezza.` }));
    const rows = await runScenario(client, { name: `breakpoint-${concurrency}`, requests, concurrency, validation: { mode: 'non_empty' } });
    const metrics = computeScenarioMetrics(`breakpoint-${concurrency}`, rows);
    const step = evaluateBreakpointStep(metrics, concurrency, baseConfig);
    steps.push(step);
    if (step.healthy) bestStableConcurrency = concurrency; else { firstUnstableConcurrency = concurrency; break; }
  }

  return { steps, bestStableConcurrency, firstUnstableConcurrency };
}

function renderStaticDashboard(outputDir: string, summary: ReturnType<typeof aggregateSummary>, scenarioMetrics: ScenarioMetrics[], sales: Record<string, number>, breakpointSteps: BreakpointStepMetrics[], suspiciousRows: Array<{scenario:string;reason:string;excerpt:string}>): void {
  const worst = [...scenarioMetrics].sort((a, b) => (b.failures/Math.max(1,b.total))-(a.failures/Math.max(1,a.total))).slice(0,5);
  const errorRows = scenarioMetrics.map(m => `<tr><td>${m.name}</td><td>${m.failures}</td><td>${m.timeoutCount}</td><td>${m.non200Count}</td><td>${m.schemaDriftCount}</td></tr>`).join('');
  const worstRows = worst.map(m => `<tr><td>${m.name}</td><td>${m.failures}/${m.total}</td></tr>`).join('');
  const concRows = breakpointSteps.length ? breakpointSteps.map(s => `<tr><td>${s.concurrency}</td><td>${((s.timeoutRate+s.errorRate+s.emptyResponseRate+s.schemaDriftRate)*100).toFixed(2)}%</td><td>${s.healthy?'Healthy':'Unstable'}</td></tr>`).join('') : '<tr><td colspan="3">Run profile=breakpoint to populate.</td></tr>';
  const suspRows = suspiciousRows.length ? suspiciousRows.map(s => `<tr><td>${s.scenario}</td><td>${s.reason}</td><td>${s.excerpt}</td></tr>`).join('') : '<tr><td colspan="3">No suspicious outputs captured.</td></tr>';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Stress Dashboard</title><style>body{font-family:Arial;margin:20px} .cards{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px} .card{border:1px solid #ddd;padding:10px;border-radius:8px} table{border-collapse:collapse;width:100%;margin-top:10px} th,td{border:1px solid #ddd;padding:6px}</style></head><body>
<h1>Chatbot Stress Dashboard</h1>
<div class="cards">
<div class="card"><b>Total</b><br>${summary.totals.total}</div>
<div class="card"><b>Success</b><br>${(summary.successRate*100).toFixed(2)}%</div>
<div class="card"><b>Failures</b><br>${summary.totals.failures}</div>
<div class="card"><b>Timeouts</b><br>${summary.totals.timeouts}</div>
</div>
<h2>Sales guidance metrics</h2>
<ul>
<li>Fitment clarification rate: ${(sales.fitmentClarificationRate*100).toFixed(2)}%</li>
<li>Purchase guidance rate: ${(sales.purchaseGuidanceRate*100).toFixed(2)}%</li>
<li>CTA presence rate: ${(sales.ctaPresenceRate*100).toFixed(2)}%</li>
<li>Early recommendation rate: ${(sales.earlyRecommendationRate*100).toFixed(2)}%</li>
<li>Suspicious response rate: ${(sales.suspiciousResponseRate*100).toFixed(2)}%</li>
</ul>
<h2>Error breakdown by scenario</h2><table><tr><th>Scenario</th><th>Failures</th><th>Timeouts</th><th>Non-200</th><th>Schema drift</th></tr>${errorRows}</table>
<h2>Concurrency vs failure rate</h2><table><tr><th>Concurrency</th><th>Failure rate</th><th>Status</th></tr>${concRows}</table>
<h2>Worst scenarios</h2><table><tr><th>Scenario</th><th>Failure ratio</th></tr>${worstRows}</table>
<h2>Suspicious outputs</h2><table><tr><th>Scenario</th><th>Reason</th><th>Excerpt</th></tr>${suspRows}</table>
<h2>Artifacts</h2><ul><li><a href="summary.json">summary.json</a></li><li><a href="scenario-metrics.json">scenario-metrics.json</a></li><li><a href="failures.jsonl">failures.jsonl</a></li><li><a href="executive-summary.md">executive-summary.md</a></li></ul>
</body></html>`;
  fs.writeFileSync(path.join(outputDir, 'dashboard.html'), html, 'utf8');
}

function writeExecutiveSummary(outputDir: string, summary: ReturnType<typeof aggregateSummary>, sales: Record<string, number>, scenarioMetrics: ScenarioMetrics[], breakpoint: {bestStableConcurrency:number;firstUnstableConcurrency:number|null}): void {
  const strong = [];
  if (sales.purchaseGuidanceRate >= 0.6) strong.push('buona capacità di guidare verso il prossimo passo commerciale');
  if (sales.fitmentClarificationRate >= 0.6) strong.push('buona raccolta delle informazioni di fitment');
  if (summary.successRate >= 0.9) strong.push('solidità tecnica generale');

  const fitmentFails = scenarioMetrics.filter((s) => s.name.includes('fitment') && s.failures > 0).map((s) => s.name);
  const commercialFails = sales.ctaPresenceRate < 0.5 || sales.tooGenericRate > 0.3;
  const md = `# Executive Summary\n\n## Dove il bot è forte\n- ${strong.length ? strong.join('\n- ') : 'Prestazioni forti non ancora evidenti con il profilo corrente.'}\n\n## Dove fallisce nel fitment journey\n- ${fitmentFails.length ? fitmentFails.join(', ') : 'Nessun fallimento fitment critico rilevato.'}\n\n## Dove perde efficacia commerciale\n- CTA presence rate: ${(sales.ctaPresenceRate*100).toFixed(2)}%\n- Purchase guidance rate: ${(sales.purchaseGuidanceRate*100).toFixed(2)}%\n- Segnale perdita efficacia: ${commercialFails ? 'SI' : 'NO'}\n\n## Degrado conversazionale sotto stress tecnico\n- Success rate: ${(summary.successRate*100).toFixed(2)}%\n- Timeout rate: ${(summary.totals.timeouts/Math.max(1,summary.totals.total)*100).toFixed(2)}%\n- Suspicious response rate: ${(sales.suspiciousResponseRate*100).toFixed(2)}%\n\n## Safe operating range stimato\n- Best stable concurrency: ${breakpoint.bestStableConcurrency}\n- First unstable concurrency: ${breakpoint.firstUnstableConcurrency ?? 'non rilevata'}\n`;
  fs.writeFileSync(path.join(outputDir, 'executive-summary.md'), md, 'utf8');
}

export async function runHarness(): Promise<void> {
  const loaded = loadConfig();
  const config: HarnessConfig = { ...loaded, ...profileOverrides(loaded) };
  ensureDir(config.outputDir);

  const client = new ChatbotClient(config);
  const scenarios = buildScenarios(config);
  const conversationScenarios = buildConversationScenarios();

  const scenarioMetrics: ScenarioMetrics[] = [];
  const allRows: ScenarioRow[] = [];

  for (const scenario of scenarios) {
    const rows = await runScenario(client, scenario);
    allRows.push(...rows);
    for (const row of rows) {
      const hardFail = row.validation.score === 'fail' || row.result.error || row.result.timedOut || (row.result.status ?? 0) !== 200;
      if (hardFail || row.validation.score === 'warn') {
        appendJsonl(path.join(config.outputDir, 'failures.jsonl'), {
          requestId: row.result.requestId,
          scenario: row.result.scenario,
          status: row.result.status,
          latencyMs: row.result.latencyMs,
          score: row.validation.score,
          validation: row.validation,
          salesSignals: row.salesSignals,
          rawBody: row.result.rawBody,
        });
      }
    }
    scenarioMetrics.push(computeScenarioMetrics(scenario.name, rows));
  }

  const conversationMetrics: ConversationRunMetrics[] = [];
  for (const conv of conversationScenarios) conversationMetrics.push(await runConversationScenario(client, conv));

  const breakpoint = config.profile === 'breakpoint'
    ? await runBreakpointSearch(config)
    : { steps: [], bestStableConcurrency: 0, firstUnstableConcurrency: null };

  const summary = aggregateSummary(scenarioMetrics);

  const total = Math.max(1, allRows.length);
  const purchaseRows = allRows.filter((r) => r.result.scenario.includes('purchase') || r.prompt.toLowerCase().includes('compra'));
  const fitmentRows = allRows.filter((r) => r.result.scenario.includes('fitment'));
  const suspiciousRows = allRows.filter((r) => !!r.validation.suspiciousReason).map((r) => ({ scenario: r.result.scenario, reason: r.validation.suspiciousReason ?? '', excerpt: (r.validation.answerText ?? '').slice(0,160) }));

  const salesMetrics = {
    conversationCompletionRate: conversationMetrics.length ? conversationMetrics.reduce((a, b) => a + b.completionRate, 0) / conversationMetrics.length : 0,
    contradictionRate: conversationMetrics.length ? conversationMetrics.reduce((a, b) => a + b.consistencyViolations, 0) / Math.max(1, conversationMetrics.reduce((a,b)=>a+b.totalTurns,0)) : 0,
    fitmentClarificationRate: fitmentRows.length ? fitmentRows.filter((r) => r.salesSignals.askedClarifyingQuestion).length / fitmentRows.length : 0,
    purchaseGuidanceRate: purchaseRows.length ? purchaseRows.filter((r) => r.salesSignals.hasCommercialCta || !r.salesSignals.tooGeneric).length / purchaseRows.length : 0,
    ctaPresenceRate: allRows.filter((r) => r.salesSignals.hasCommercialCta).length / total,
    earlyRecommendationRate: allRows.filter((r) => r.salesSignals.earlyRecommendation).length / total,
    tooGenericRate: allRows.filter((r) => r.salesSignals.tooGeneric).length / total,
    unsafeFitmentRate: allRows.filter((r) => r.salesSignals.potentialUnsafeFitment).length / total,
    suspiciousResponseRate: suspiciousRows.length / total,
  };

  writeJson(path.join(config.outputDir, 'summary.json'), { ...summary, salesMetrics, breakpoint });
  writeJson(path.join(config.outputDir, 'scenario-metrics.json'), scenarioMetrics);
  writeJson(path.join(config.outputDir, 'conversation-metrics.json'), conversationMetrics);
  writeJson(path.join(config.outputDir, 'sales-metrics.json'), salesMetrics);
  writeCsv(config.outputDir, scenarioMetrics);

  const reportHtml = `<html><body><h1>Scenario Metrics</h1><table border="1"><tr><th>Scenario</th><th>Total</th><th>Success%</th><th>p95</th><th>Failures</th></tr>${scenarioMetrics.map(m=>`<tr><td>${m.name}</td><td>${m.total}</td><td>${(m.successRate*100).toFixed(1)}</td><td>${m.p95}</td><td>${m.failures}</td></tr>`).join('')}</table></body></html>`;
  fs.writeFileSync(path.join(config.outputDir, 'report.html'), reportHtml, 'utf8');

  renderStaticDashboard(config.outputDir, summary, scenarioMetrics, salesMetrics, breakpoint.steps, suspiciousRows.slice(0, 12));
  writeExecutiveSummary(config.outputDir, summary, salesMetrics, scenarioMetrics, breakpoint);

  console.log('=== Chatbot Stress Summary ===');
  console.log(`Profile: ${config.profile}`);
  console.log(`Success rate: ${(summary.successRate * 100).toFixed(2)}%`);
  console.log(`Purchase guidance rate: ${(salesMetrics.purchaseGuidanceRate * 100).toFixed(2)}%`);
  console.log(`Fitment clarification rate: ${(salesMetrics.fitmentClarificationRate * 100).toFixed(2)}%`);
  console.log(`Dashboard: ${path.join(config.outputDir, 'dashboard.html')}`);
}
