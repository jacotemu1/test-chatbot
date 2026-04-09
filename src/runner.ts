import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { ChatbotClient } from './client/chatbotClient';
import { loadConfig } from './config';
import { computeScenarioMetrics, EvaluatedResult } from './metrics';
import { evaluateSalesSignals } from './salesEvaluator';
import { categorizeFailure } from './failureCategorizer';
import { validateResult } from './validator';
import { appendJsonl, ensureDir, writeJson } from './utils/fs';
import { BreakpointStepMetrics, ConversationRunMetrics, ConversationScenario, HarnessConfig, ScenarioDefinition, ScenarioMetrics } from './types';
import { buildScenarios, profileOverrides } from '../scenarios';
import { buildConversationScenarios } from '../scenarios/conversations';

type ScenarioRow = EvaluatedResult & {
  prompt: string;
  answer: string;
  salesSignals: ReturnType<typeof evaluateSalesSignals>;
  categories: string[];
};

type TranscriptTurn = { role: 'user' | 'bot'; text: string; timestamp: string; latencyMs?: number; result?: 'pass'|'warn'|'fail'; issues?: string[] };
type Transcript = {
  id: string;
  scenarioId: string;
  scenarioCategory: string;
  startedAt: string;
  result: 'pass'|'warn'|'fail';
  issues: string[];
  userTurns: number;
  botTurns: number;
  turns: TranscriptTurn[];
};

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function hardFailure(result: ScenarioRow['result']): boolean {
  return !!result.error || result.timedOut || (result.status ?? 0) !== 200;
}

function saveTranscriptArtifacts(baseDir: string, transcript: Transcript): { htmlPath: string; jsonPath: string; mdPath: string } {
  const convoDir = path.join(baseDir, 'conversations');
  ensureDir(convoDir);

  const safe = transcript.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const jsonPath = path.join(convoDir, `${safe}.json`);
  const mdPath = path.join(convoDir, `${safe}.md`);
  const htmlPath = path.join(convoDir, `${safe}.html`);

  writeJson(jsonPath, transcript);

  const md = [
    `# Conversation ${transcript.id}`,
    `- Scenario: ${transcript.scenarioId}`,
    `- Category: ${transcript.scenarioCategory}`,
    `- Result: ${transcript.result}`,
    `- Issues: ${transcript.issues.join(', ') || 'none'}`,
    '',
    ...transcript.turns.map((t) => `**${t.role.toUpperCase()}** (${t.timestamp})${t.latencyMs ? ` [${t.latencyMs}ms]` : ''}: ${t.text}`),
  ].join('\n');
  fs.writeFileSync(mdPath, md, 'utf8');

  const bubbles = transcript.turns.map((t) => {
    const cls = t.role === 'user' ? 'user' : 'bot';
    const suspicious = t.issues && t.issues.length ? ' suspicious' : '';
    const issues = t.issues?.length ? `<div class="issues">Issues: ${t.issues.join(', ')}</div>` : '';
    return `<div class="bubble ${cls}${suspicious}"><div class="meta">${t.role.toUpperCase()} • ${t.timestamp}${t.latencyMs ? ` • ${t.latencyMs}ms` : ''}${t.result ? ` • ${t.result}` : ''}</div><div>${t.text || '[empty]'}</div>${issues}</div>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${transcript.id}</title>
  <style>body{font-family:Arial;margin:20px}.meta{font-size:12px;color:#666}.bubble{padding:10px;border-radius:10px;margin:8px 0;max-width:900px}.user{background:#e8f0ff}.bot{background:#f2f2f2}.suspicious{border:2px solid #d33}.issues{margin-top:6px;color:#b30000;font-size:12px}</style></head>
  <body><h1>${transcript.scenarioId}</h1><p>Result: <b>${transcript.result}</b> | Category: ${transcript.scenarioCategory} | Issues: ${transcript.issues.join(', ') || 'none'}</p>${bubbles}</body></html>`;
  fs.writeFileSync(htmlPath, html, 'utf8');

  return { htmlPath, jsonPath, mdPath };
}

async function captureScreenshots(baseDir: string, pages: Array<{ id: string; result: 'pass'|'warn'|'fail'; htmlPath: string }>): Promise<string[]> {
  const shotDir = path.join(baseDir, 'screenshots');
  ensureDir(shotDir);

  const picked = pages.filter((p) => p.result !== 'pass');
  const passSample = pages.filter((p) => p.result === 'pass').slice(0, 3);
  const targets = [...picked, ...passSample];

  const files: string[] = [];
  if (!targets.length) return files;

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    for (const t of targets) {
      const out = path.join(shotDir, `${t.id}__${t.result}.png`);
      await page.goto(`file://${t.htmlPath}`);
      await page.screenshot({ path: out, fullPage: true });
      files.push(out);
    }
    await browser.close();
  } catch {
    // keep run resilient if screenshoting is unavailable
  }

  return files;
}

async function runScenario(client: ChatbotClient, scenario: ScenarioDefinition): Promise<ScenarioRow[]> {
  const batches = chunkArray(scenario.requests, Math.max(1, scenario.concurrency));
  const rows: ScenarioRow[] = [];

  for (const batch of batches) {
    const settled = await Promise.all(batch.map((payload) => client.send(payload, scenario.name, scenario.timeoutMs)));
    settled.forEach((result, idx) => {
      const prompt = String(batch[idx].input ?? '');
      const validation = validateResult(result, scenario.validation);
      const answer = validation.answerText ?? result.rawBody ?? '';
      const salesSignals = evaluateSalesSignals(prompt, answer);
      const categories = categorizeFailure({
        validation,
        sales: salesSignals,
        isTechnicalFailure: !!result.error || result.timedOut || (result.status ?? 0) !== 200,
      });
      rows.push({ result, validation, prompt, answer, salesSignals, categories });
    });
  }
  return rows;
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

  const totalTurns = scenario.turns.length;
  const completedTurns = turns.filter((t) => t.ok).length;
  const completionRate = totalTurns ? completedTurns / totalTurns : 0;
  const turnLatenciesMs = turns.map((t) => t.latencyMs);
  const avgTurnLatencyMs = turnLatenciesMs.length
    ? turnLatenciesMs.reduce((a, b) => a + b, 0) / turnLatenciesMs.length
    : 0;
  const split = Math.max(1, Math.floor(turnLatenciesMs.length * 0.3));
  const early = turnLatenciesMs.slice(0, split);
  const late = turnLatenciesMs.slice(-split);
  const earlyAvg = early.length ? early.reduce((a, b) => a + b, 0) / early.length : 1;
  const lateAvg = late.length ? late.reduce((a, b) => a + b, 0) / late.length : earlyAvg;

  return {
    scenario: scenario.name,
    totalTurns,
    completedTurns,
    completionRate,
    turnLatenciesMs,
    avgTurnLatencyMs,
    lateTurnLatencyGrowthRatio: earlyAvg > 0 ? lateAvg / earlyAvg : 1,
    consistencyViolations: 0,
    memoryFailures: 0,
    unstableRephraseCount: 0,
  };
}

function aggregateSummary(metrics: ScenarioMetrics[]) {
  const totals = metrics.reduce((acc, m) => {
    acc.total += m.total;
    acc.failures += m.failures;
    acc.warns += m.warns;
    acc.timeouts += m.timeoutCount;
    acc.non200 += m.non200Count;
    acc.parseFailures += m.parseFailureCount;
    acc.empty += m.emptyResponseCount;
    acc.schemaDrift += m.schemaDriftCount;
    return acc;
  }, { total: 0, failures: 0, warns: 0, timeouts: 0, non200: 0, parseFailures: 0, empty: 0, schemaDrift: 0 });

  return { generatedAt: new Date().toISOString(), totals, successRate: totals.total ? (totals.total - totals.failures) / totals.total : 0, scenarios: metrics.length };
}

function writeCsv(outputDir: string, metrics: ScenarioMetrics[]): void {
  const header = 'scenario,total,success_rate,p50,p95,p99,timeouts,non200,parse_failures,empty,schema_drift,dup_ratio,answer_len_avg,warns,failures';
  const rows = metrics.map((m) => [m.name,m.total,m.successRate,m.p50,m.p95,m.p99,m.timeoutCount,m.non200Count,m.parseFailureCount,m.emptyResponseCount,m.schemaDriftCount,m.duplicateResponseRatio,m.answerLengthAvg,m.warns,m.failures].join(','));
  fs.writeFileSync(path.join(outputDir, 'scenario-metrics.csv'), [header, ...rows].join('\n'), 'utf8');
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
  return { concurrency, total, p95LatencyMs: metrics.p95, timeoutRate, errorRate, emptyResponseRate, schemaDriftRate, healthy: violations.length===0, violations };
}

async function runBreakpointSearch(baseConfig: HarnessConfig): Promise<{ steps: BreakpointStepMetrics[]; bestStableConcurrency: number; firstUnstableConcurrency: number | null; }> {
  const steps: BreakpointStepMetrics[] = [];
  const stepSize = Math.max(1, Math.floor(baseConfig.maxConcurrency / baseConfig.rampSteps));
  let bestStableConcurrency = 0;
  let firstUnstableConcurrency: number | null = null;

  for (let concurrency = 1; concurrency <= baseConfig.maxConcurrency; concurrency += stepSize) {
    const client = new ChatbotClient({ ...baseConfig, maxConcurrency: concurrency });
    const requests = Array.from({ length: Math.max(40, Math.floor(baseConfig.totalRequests / 2)) }, (_, i) => ({ input: `Breakpoint probe #${i} for tyre recommendation and safe fitment.` }));
    const rows = await runScenario(client, { name: `breakpoint-${concurrency}`, requests, concurrency, validation: { mode: 'non_empty' } });
    const metrics = computeScenarioMetrics(`breakpoint-${concurrency}`, rows);
    const step = evaluateBreakpointStep(metrics, concurrency, baseConfig);
    steps.push(step);
    if (step.healthy) bestStableConcurrency = concurrency; else { firstUnstableConcurrency = concurrency; break; }
  }
  return { steps, bestStableConcurrency, firstUnstableConcurrency };
}

function buildMainReport(outputDir: string, summary: ReturnType<typeof aggregateSummary>, scenarioMetrics: ScenarioMetrics[], sales: Record<string, number>, topCategories: Array<[string, number]>, topScenarios: ScenarioMetrics[], transcripts: Transcript[], screenshots: string[]): void {
  const reportDir = path.join(outputDir, 'report');
  ensureDir(reportDir);

  const rows = scenarioMetrics.map((m) => `<tr><td>${m.name}</td><td>${m.total}</td><td>${(m.successRate*100).toFixed(1)}%</td><td>${m.p95}</td><td>${m.failures}</td></tr>`).join('');
  const catRows = topCategories.map(([k,v]) => `<li>${k}: ${v}</li>`).join('');
  const topScenarioRows = topScenarios.map((s)=>`<li>${s.name} (${s.failures}/${s.total})</li>`).join('');

  const transcriptRows = transcripts.slice(0, 120).map((t) => {
    const page = `../conversations/${t.id}.html`;
    const shot = screenshots.find((s) => path.basename(s).startsWith(t.id));
    const thumb = shot ? `<img src="../screenshots/${path.basename(shot)}" style="width:220px;border:1px solid #ccc"/>` : '';
    return `<tr><td><a href="${page}">${t.id}</a></td><td>${t.scenarioId}</td><td>${t.result}</td><td>${t.issues.join(', ')}</td><td>${thumb}</td></tr>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Investigation Report</title><style>body{font-family:Arial;margin:20px} .cards{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:10px} .card{border:1px solid #ddd;padding:10px;border-radius:8px} table{border-collapse:collapse;width:100%;margin-top:10px} th,td{border:1px solid #ddd;padding:6px;vertical-align:top}</style></head><body>
<h1>Chatbot Investigation Report</h1>
<div class="cards"><div class="card"><b>Total</b><br>${summary.totals.total}</div><div class="card"><b>Success</b><br>${(summary.successRate*100).toFixed(2)}%</div><div class="card"><b>Warn</b><br>${summary.totals.warns}</div><div class="card"><b>Fail</b><br>${summary.totals.failures}</div></div>
<h2>Top failing categories</h2><ul>${catRows}</ul>
<h2>Top failing scenarios</h2><ul>${topScenarioRows}</ul>
<h2>Latency overview</h2><p>Timeout rate ${(summary.totals.timeouts/Math.max(1,summary.totals.total)*100).toFixed(2)}% • Non-200 ${summary.totals.non200}</p>
<h2>Commercial progression issues</h2><ul><li>CTA presence rate: ${(sales.ctaPresenceRate*100).toFixed(2)}%</li><li>Purchase guidance rate: ${(sales.purchaseGuidanceRate*100).toFixed(2)}%</li><li>No CTA/next step rate: ${(sales.noCtaRate*100).toFixed(2)}%</li></ul>
<h2>Fitment-flow issues</h2><ul><li>Fitment clarification rate: ${(sales.fitmentClarificationRate*100).toFixed(2)}%</li><li>Unsafe fitment rate: ${(sales.unsafeFitmentRate*100).toFixed(2)}%</li><li>Premature recommendation rate: ${(sales.earlyRecommendationRate*100).toFixed(2)}%</li></ul>
<h2>Where the bot does not understand the user</h2><p>Keyword miss and misunderstood_intent patterns are summarized in failure categories and transcript issue tags.</p>
<h2>Where the bot goes off-track</h2><p>See categories irrelevant_answer, contradiction, unstable_repeated_answer and transcript pages.</p>
<h2>Where the bot fails commercially</h2><p>See no_cta_or_next_step, generic_non_answer, and low purchase-guidance rate.</p>
<h2>Where the bot becomes unreliable under stress</h2><p>See timeout_or_technical_failure rates and breakpoint summary in summary.json.</p>
<h2>Scenario metrics</h2><table><tr><th>Scenario</th><th>Total</th><th>Success</th><th>p95</th><th>Failures</th></tr>${rows}</table>
<h2>Conversation pages</h2><table><tr><th>Transcript</th><th>Scenario</th><th>Result</th><th>Issues</th><th>Screenshot</th></tr>${transcriptRows}</table>
</body></html>`;

  fs.writeFileSync(path.join(reportDir, 'index.html'), html, 'utf8');
}

function writeJobSummary(outputDir: string, lines: string[]): void {
  fs.writeFileSync(path.join(outputDir, 'job-summary.md'), lines.join('\n'), 'utf8');
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
  const transcripts: Transcript[] = [];
  const pageRefs: Array<{ id: string; result: 'pass'|'warn'|'fail'; htmlPath: string }> = [];

  for (const scenario of scenarios) {
    const rows = await runScenario(client, scenario);
    allRows.push(...rows);

    rows.forEach((row, idx) => {
      const techFail = hardFailure(row.result);
      const resultLabel: 'pass'|'warn'|'fail' = techFail || row.validation.score === 'fail' ? 'fail' : row.validation.score === 'warn' ? 'warn' : 'pass';
      const issues = [...new Set([...(row.categories || []), ...(row.validation.suspiciousReason ? [row.validation.suspiciousReason] : [])])];

      const transcript: Transcript = {
        id: `${scenario.name}-${idx + 1}-${randomUUID().slice(0, 8)}`,
        scenarioId: scenario.name,
        scenarioCategory: scenario.tags?.[0] ?? scenario.name,
        startedAt: row.result.startedAt,
        result: resultLabel,
        issues,
        userTurns: 1,
        botTurns: 1,
        turns: [
          { role: 'user', text: row.prompt, timestamp: row.result.startedAt },
          { role: 'bot', text: row.answer, timestamp: new Date().toISOString(), latencyMs: row.result.latencyMs, result: resultLabel, issues },
        ],
      };
      transcripts.push(transcript);
      const refs = saveTranscriptArtifacts(config.outputDir, transcript);
      pageRefs.push({ id: transcript.id, result: transcript.result, htmlPath: refs.htmlPath });

      if (resultLabel !== 'pass') {
        appendJsonl(path.join(config.outputDir, 'failures.jsonl'), {
          requestId: row.result.requestId,
          scenario: row.result.scenario,
          status: row.result.status,
          latencyMs: row.result.latencyMs,
          result: resultLabel,
          categories: row.categories,
          validation: row.validation,
          salesSignals: row.salesSignals,
          prompt: row.prompt,
          answer: row.answer,
        });
      }
    });

    scenarioMetrics.push(computeScenarioMetrics(scenario.name, rows));
  }

  const conversationMetrics: ConversationRunMetrics[] = [];
  for (const conv of conversationScenarios) {
    const run = await runConversationScenario(client, conv);
    conversationMetrics.push(run);
    const resultLabel: 'pass'|'warn'|'fail' = run.consistencyViolations > 0 || run.memoryFailures > 0 ? 'fail' : run.unstableRephraseCount > 0 || run.lateTurnLatencyGrowthRatio > 1.4 ? 'warn' : 'pass';
    const issues = categorizeFailure({
      validation: { parseFailure:false, emptyResponse:false, schemaDrift:false, keywordMiss:false, genericFailureDetected:false, suspiciousSignals:[], score: resultLabel === 'pass' ? 'pass' : resultLabel, knownFlakySemantic:false },
      sales: { askedClarifyingQuestion:true, earlyRecommendation:false, hasCommercialCta:true, tooGeneric:false, potentialUnsafeFitment:false },
      isTechnicalFailure: false,
      contradiction: run.consistencyViolations > 0,
      unstableRepeated: run.unstableRephraseCount > 0,
      longContextDegradation: run.lateTurnLatencyGrowthRatio > 1.4,
    });

    const t: Transcript = {
      id: `${conv.name}-${randomUUID().slice(0, 8)}`,
      scenarioId: conv.name,
      scenarioCategory: 'conversation',
      startedAt: new Date().toISOString(),
      result: resultLabel,
      issues,
      userTurns: conv.turns.length,
      botTurns: conv.turns.length,
      turns: conv.turns
        .map((x) => ({ role: 'user' as const, text: x.userPrompt, timestamp: new Date().toISOString() }))
        .flatMap((u, i) => [u, { role: 'bot' as const, text: `[captured in metrics]`, timestamp: new Date().toISOString(), latencyMs: run.turnLatenciesMs[i], result: resultLabel, issues }]),
    };
    transcripts.push(t);
    const refs = saveTranscriptArtifacts(config.outputDir, t);
    pageRefs.push({ id: t.id, result: t.result, htmlPath: refs.htmlPath });
  }

  const breakpoint = config.profile === 'breakpoint'
    ? await runBreakpointSearch(config)
    : { steps: [], bestStableConcurrency: 0, firstUnstableConcurrency: null };

  const summary = aggregateSummary(scenarioMetrics);
  const total = Math.max(1, allRows.length);
  const purchaseRows = allRows.filter((r) => r.result.scenario.includes('purchase') || r.prompt.toLowerCase().includes('buy'));
  const fitmentRows = allRows.filter((r) => r.result.scenario.includes('fitment'));

  const salesMetrics = {
    conversationCompletionRate: conversationMetrics.length ? conversationMetrics.reduce((a,b)=>a+b.completionRate,0)/conversationMetrics.length : 0,
    contradictionRate: conversationMetrics.length ? conversationMetrics.reduce((a,b)=>a+b.consistencyViolations,0)/Math.max(1,conversationMetrics.reduce((a,b)=>a+b.totalTurns,0)) : 0,
    fitmentClarificationRate: fitmentRows.length ? fitmentRows.filter((r)=>r.salesSignals.askedClarifyingQuestion).length/fitmentRows.length : 0,
    purchaseGuidanceRate: purchaseRows.length ? purchaseRows.filter((r)=>r.salesSignals.hasCommercialCta || !r.salesSignals.tooGeneric).length/purchaseRows.length : 0,
    ctaPresenceRate: allRows.filter((r)=>r.salesSignals.hasCommercialCta).length/total,
    earlyRecommendationRate: allRows.filter((r)=>r.salesSignals.earlyRecommendation).length/total,
    unsafeFitmentRate: allRows.filter((r)=>r.salesSignals.potentialUnsafeFitment).length/total,
    suspiciousResponseRate: allRows.filter((r)=>!!r.validation.suspiciousReason).length/total,
    noCtaRate: allRows.filter((r)=>!r.salesSignals.hasCommercialCta).length/total,
  };

  const categoryCounter = new Map<string, number>();
  transcripts.forEach((t) => t.issues.forEach((c) => categoryCounter.set(c, (categoryCounter.get(c) ?? 0) + 1)));
  const topCategories = [...categoryCounter.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const topFailScenarios = [...scenarioMetrics].sort((a,b)=>b.failures-a.failures).slice(0,10);

  const screenshots = await captureScreenshots(config.outputDir, pageRefs);

  writeJson(path.join(config.outputDir, 'summary.json'), { ...summary, salesMetrics, breakpoint, screenshots: screenshots.length });
  writeJson(path.join(config.outputDir, 'scenario-metrics.json'), scenarioMetrics);
  writeJson(path.join(config.outputDir, 'conversation-metrics.json'), conversationMetrics);
  writeJson(path.join(config.outputDir, 'sales-metrics.json'), salesMetrics);
  writeCsv(config.outputDir, scenarioMetrics);

  buildMainReport(config.outputDir, summary, scenarioMetrics, salesMetrics, topCategories, topFailScenarios, transcripts, screenshots);

  const suspiciousTop = allRows.filter((r) => !!r.validation.suspiciousReason).slice(0,10).map((r) => ({ scenario:r.result.scenario, answer:r.answer.slice(0,200), reason:r.validation.suspiciousReason }));
  const ineffectiveTop = allRows.filter((r)=>!r.salesSignals.hasCommercialCta || r.salesSignals.tooGeneric).slice(0,10).map((r)=>({scenario:r.result.scenario,prompt:r.prompt.slice(0,120),answer:r.answer.slice(0,160)}));
  writeJson(path.join(config.outputDir, 'top-10-worst-conversations.json'), transcripts.filter((t)=>t.result!=='pass').slice(0,10));
  writeJson(path.join(config.outputDir, 'top-10-suspicious-answers.json'), suspiciousTop);
  writeJson(path.join(config.outputDir, 'top-10-commercially-ineffective.json'), ineffectiveTop);

  const jobSummaryLines = [
    '# Chatbot Stress Investigation Summary',
    '',
    `- Success rate: ${(summary.successRate*100).toFixed(2)}%`,
    `- Warn count: ${summary.totals.warns}`,
    `- Fail count: ${summary.totals.failures}`,
    `- Fitment clarification rate: ${(salesMetrics.fitmentClarificationRate*100).toFixed(2)}%`,
    `- Purchase guidance rate: ${(salesMetrics.purchaseGuidanceRate*100).toFixed(2)}%`,
    `- CTA presence rate: ${(salesMetrics.ctaPresenceRate*100).toFixed(2)}%`,
    '',
    '## Top 10 worst conversations',
    ...transcripts.filter((t)=>t.result!=='pass').slice(0,10).map((t)=>`- ${t.id} (${t.result}) [${t.issues.join(', ')}]`),
    '',
    '## Top 10 most suspicious answers',
    ...suspiciousTop.map((x)=>`- ${x.scenario}: ${x.reason}`),
    '',
    '## Top 10 commercially ineffective conversations',
    ...ineffectiveTop.map((x)=>`- ${x.scenario}: missing CTA or too generic`),
  ];
  writeJobSummary(config.outputDir, jobSummaryLines);

  console.log('=== Chatbot Stress Summary ===');
  console.log(`Profile: ${config.profile}`);
  console.log(`Main report: ${path.join(config.outputDir, 'report/index.html')}`);
  console.log(`Conversation pages: ${path.join(config.outputDir, 'conversations')}`);
  console.log(`Screenshots: ${path.join(config.outputDir, 'screenshots')}`);
}
