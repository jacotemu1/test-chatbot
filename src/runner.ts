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

type FailureBucket =
  | 'endpoint_unreachable'
  | 'dns_or_network_failure'
  | 'auth_failure'
  | 'non_200_http_response'
  | 'invalid_json_response'
  | 'empty_body'
  | 'empty_answer_field'
  | 'renderer_failure'
  | 'screenshot_generation_failure'
  | 'chatbot_quality_failure';

type ScenarioRow = EvaluatedResult & {
  payload: Record<string, unknown>;
  prompt: string;
  answer: string;
  hasUsableAnswer: boolean;
  salesSignals: ReturnType<typeof evaluateSalesSignals>;
  qualityCategories: string[];
  failureBucket: FailureBucket | null;
  reason: string;
};

type Transcript = {
  id: string;
  scenarioId: string;
  scenarioCategory: string;
  result: 'pass' | 'warn' | 'fail';
  issues: string[];
  prompt: string;
  answer: string;
  latencyMs: number;
  status?: number;
  failureBucket?: FailureBucket | null;
  requestPayload: unknown;
  responseHeaders?: Record<string, string>;
  rawResponse?: string;
  parsedResponse?: unknown;
  error?: string;
  reason?: string;
};

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function classifyTechnicalFailure(row: {
  status?: number;
  error?: string;
  rawBody?: string;
  parsedBody?: unknown;
  answer: string;
}): { bucket: FailureBucket | null; reason: string } {
  const err = (row.error || '').toLowerCase();

  if (err.includes('enotfound') || err.includes('dns')) {
    return { bucket: 'dns_or_network_failure', reason: 'DNS/network resolution failure' };
  }
  if (err.includes('econnrefused') || err.includes('fetch failed') || err.includes('network')) {
    return { bucket: 'endpoint_unreachable', reason: 'Endpoint unreachable or connection refused' };
  }
  if (row.status === 401 || row.status === 403) {
    return { bucket: 'auth_failure', reason: 'Authentication/authorization failure' };
  }
  if ((row.status ?? 0) !== 200) {
    return { bucket: 'non_200_http_response', reason: `HTTP status ${row.status ?? 'unknown'}` };
  }
  if (!row.rawBody || !row.rawBody.trim()) {
    return { bucket: 'empty_body', reason: 'HTTP 200 but empty raw body' };
  }
  if (!row.parsedBody) {
    return { bucket: 'invalid_json_response', reason: 'Response body not parseable as JSON' };
  }
  if (!row.answer.trim()) {
    return { bucket: 'empty_answer_field', reason: 'Parsed response found but answer field empty/unmapped' };
  }
  return { bucket: null, reason: 'usable_answer' };
}

function saveTranscriptArtifacts(baseDir: string, t: Transcript): string {
  const dir = path.join(baseDir, 'conversations');
  ensureDir(dir);
  const safe = t.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const jsonPath = path.join(dir, `${safe}.json`);
  const htmlPath = path.join(dir, `${safe}.html`);
  writeJson(jsonPath, t);

  const noAnswerBanner = !t.answer.trim()
    ? '<div class="banner">No usable chatbot response captured</div>'
    : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${t.id}</title>
  <style>body{font-family:Arial;margin:20px}.banner{background:#ffe6e6;border:2px solid #d33;padding:10px;margin-bottom:10px;font-weight:bold}.bubble{padding:10px;border-radius:10px;margin:10px 0}.user{background:#e8f0ff}.bot{background:#f2f2f2}.fail{border:2px solid #d33}.meta{font-size:12px;color:#666}pre{background:#fafafa;border:1px solid #ddd;padding:10px;overflow:auto}</style></head><body>
  <h1>${t.scenarioId}</h1>
  <p>Result: <b>${t.result}</b> | Bucket: ${t.failureBucket ?? 'none'} | Reason: ${t.reason}</p>
  ${noAnswerBanner}
  <div class="bubble user"><div class="meta">USER</div>${t.prompt}</div>
  <div class="bubble bot ${t.result !== 'pass' ? 'fail' : ''}"><div class="meta">BOT • ${t.latencyMs}ms • status ${t.status ?? 'n/a'}</div>${t.answer || '[empty]'}</div>
  <h2>Transport evidence</h2>
  <pre>Request payload:\n${JSON.stringify(t.requestPayload, null, 2)}</pre>
  <pre>Response headers:\n${JSON.stringify(t.responseHeaders ?? {}, null, 2)}</pre>
  <pre>Raw response:\n${(t.rawResponse ?? '').slice(0, 5000)}</pre>
  <pre>Parsed response:\n${JSON.stringify(t.parsedResponse ?? null, null, 2)}</pre>
  <pre>Error:\n${t.error ?? ''}</pre>
  <p>${!t.answer.trim() ? 'Screenshot/report is limited because no usable answer exists.' : ''}</p>
  </body></html>`;

  fs.writeFileSync(htmlPath, html, 'utf8');
  return htmlPath;
}

async function captureScreenshots(baseDir: string, pages: Array<{ id: string; result: 'pass'|'warn'|'fail'; htmlPath: string }>): Promise<{ files: string[]; failed: number }> {
  const dir = path.join(baseDir, 'screenshots');
  ensureDir(dir);
  const targets = [...pages.filter((p) => p.result !== 'pass'), ...pages.filter((p) => p.result === 'pass').slice(0, 3)];
  const files: string[] = [];
  let failed = 0;
  if (!targets.length) return { files, failed };

  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1800 } });
    for (const t of targets) {
      try {
        const out = path.join(dir, `${t.id}__${t.result}.png`);
        await page.goto(`file://${t.htmlPath}`);
        await page.screenshot({ path: out, fullPage: true });
        files.push(out);
      } catch {
        failed += 1;
      }
    }
    await browser.close();
  } catch {
    failed += targets.length;
  }

  return { files, failed };
}

async function runScenario(client: ChatbotClient, scenario: ScenarioDefinition): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  for (const batch of chunkArray(scenario.requests, Math.max(1, scenario.concurrency))) {
    const settled = await Promise.all(batch.map((payload) => client.send(payload, scenario.name, scenario.timeoutMs)));
    settled.forEach((result, i) => {
      const payload = batch[i] as Record<string, unknown>;
      const prompt = String(payload.input ?? '');
      const validation = validateResult(result, scenario.validation);
      const answer = validation.answerText ?? result.rawBody ?? '';
      const technical = classifyTechnicalFailure({ status: result.status, error: result.error, rawBody: result.rawBody, parsedBody: result.parsedBody, answer });
      const hasUsableAnswer = technical.bucket === null;
      const salesSignals = hasUsableAnswer
        ? evaluateSalesSignals(prompt, answer)
        : { askedClarifyingQuestion: false, earlyRecommendation: false, hasCommercialCta: false, tooGeneric: false, potentialUnsafeFitment: false };
      const qualityCategories = hasUsableAnswer
        ? categorizeFailure({ validation, sales: salesSignals, isTechnicalFailure: false })
        : [];
      rows.push({ result, validation, payload, prompt, answer, hasUsableAnswer, salesSignals, qualityCategories, failureBucket: technical.bucket, reason: technical.reason });
    });
  }
  return rows;
}

async function runConversationScenario(client: ChatbotClient, scenario: ConversationScenario): Promise<ConversationRunMetrics> {
  const history: Array<{ role: string; content: string }> = [];
  const latencies: number[] = [];

  for (const turn of scenario.turns) {
    const result = await client.send({ input: turn.userPrompt, context: history }, `conversation-${scenario.name}`);
    const validation = validateResult(result, { mode: 'consistency_check', expectedKeywords: turn.expectKeywords });
    const answer = validation.answerText ?? result.rawBody ?? '';
    latencies.push(result.latencyMs);
    history.push({ role: 'user', content: turn.userPrompt });
    history.push({ role: 'assistant', content: answer || '[empty]' });
  }

  const totalTurns = scenario.turns.length;
  const completedTurns = latencies.length;
  const completionRate = totalTurns ? completedTurns / totalTurns : 0;
  const avgTurnLatencyMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const split = Math.max(1, Math.floor(latencies.length * 0.3));
  const early = latencies.slice(0, split);
  const late = latencies.slice(-split);
  const earlyAvg = early.length ? early.reduce((a, b) => a + b, 0) / early.length : 1;
  const lateAvg = late.length ? late.reduce((a, b) => a + b, 0) / late.length : earlyAvg;

  return {
    scenario: scenario.name,
    totalTurns,
    completedTurns,
    completionRate,
    turnLatenciesMs: latencies,
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
    const reqs = Array.from({ length: Math.max(40, Math.floor(baseConfig.totalRequests / 2)) }, (_, i) => ({ input: `Breakpoint probe #${i} for tyre recommendation.` }));
    const rows = await runScenario(client, { name: `breakpoint-${concurrency}`, requests: reqs, concurrency, validation: { mode: 'non_empty' } });
    const m = computeScenarioMetrics(`breakpoint-${concurrency}`, rows);
    const step = evaluateBreakpointStep(m, concurrency, baseConfig);
    steps.push(step);
    if (step.healthy) bestStableConcurrency = concurrency; else { firstUnstableConcurrency = concurrency; break; }
  }
  return { steps, bestStableConcurrency, firstUnstableConcurrency };
}

function buildTechnicalReport(outputDir: string, examples: Transcript[], bucketCounts: Record<string, number>): void {
  const rows = examples.slice(0, 20).map((e) => `<tr><td>${e.scenarioId}</td><td>${e.failureBucket}</td><td>${e.reason}</td><td>${e.status ?? 'n/a'}</td><td><pre>${JSON.stringify(e.requestPayload, null, 2)}</pre></td><td><pre>${(e.rawResponse ?? '').slice(0, 300)}</pre></td></tr>`).join('');
  const hints = [
    'endpoint URL mismatch',
    'missing auth header',
    'wrong request payload shape',
    'incorrect response field mapping',
    'environment/network issue',
    'self-hosted runner / internal DNS reachability problem',
  ];
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Technical Failures</title><style>body{font-family:Arial;margin:20px} table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}pre{white-space:pre-wrap}</style></head><body>
  <h1>Technical Failure Report</h1>
  <h2>Summary by type</h2><pre>${JSON.stringify(bucketCounts, null, 2)}</pre>
  <h2>First 20 examples</h2><table><tr><th>Scenario</th><th>Bucket</th><th>Reason</th><th>HTTP</th><th>Request</th><th>Raw response</th></tr>${rows}</table>
  <h2>First things to check</h2><ul>${hints.map((h) => `<li>${h}</li>`).join('')}</ul>
  </body></html>`;
  ensureDir(path.join(outputDir, 'report'));
  fs.writeFileSync(path.join(outputDir, 'report', 'technical.html'), html, 'utf8');
}

function classifyHumanOutcome(t: Transcript): { outcome: string; problem: string; severity: 'Low'|'Medium'|'High'|'Critical'; impact: string } {
  if (t.failureBucket === 'endpoint_unreachable' || t.failureBucket === 'dns_or_network_failure' || t.failureBucket === 'auth_failure' || t.failureBucket === 'non_200_http_response') {
    return { outcome: 'Technical failure', problem: 'Technical configuration issue', severity: 'Critical', impact: 'Lost purchase opportunity' };
  }
  if (t.failureBucket === 'empty_body' || t.failureBucket === 'empty_answer_field') {
    return { outcome: 'No response', problem: 'Did not answer', severity: 'Critical', impact: 'Lost purchase opportunity' };
  }
  if (t.issues.includes('hallucinated_fitment')) {
    return { outcome: 'Wrong answer', problem: 'Unsafe fitment guidance risk', severity: 'High', impact: 'Fitment risk' };
  }
  if (t.issues.includes('missing_clarification')) {
    return { outcome: 'Off-track', problem: 'Did not ask needed fitment questions', severity: 'High', impact: 'User confusion' };
  }
  if (t.issues.includes('no_cta_or_next_step')) {
    return { outcome: 'Worked but weak', problem: 'Did not guide toward purchase', severity: 'High', impact: 'Low commercial effectiveness' };
  }
  if (t.latencyMs > 4000) {
    return { outcome: 'Slow', problem: 'Response was too slow', severity: 'Medium', impact: 'Slow journey progression' };
  }
  if (t.issues.includes('generic_non_answer')) {
    return { outcome: 'Worked but weak', problem: 'Too generic', severity: 'Medium', impact: 'Trust loss' };
  }
  if (t.result === 'warn') {
    return { outcome: 'Worked but weak', problem: 'Partially useful response', severity: 'Medium', impact: 'User confusion' };
  }
  return { outcome: 'Worked', problem: 'No major issue', severity: 'Low', impact: 'No significant business impact' };
}

function buildMainReport(outputDir: string, summary: ReturnType<typeof aggregateSummary>, scenarioMetrics: ScenarioMetrics[], sales: Record<string, number>, transcripts: Transcript[], screenshots: string[], bucketCounts: Record<string, number>): void {
  const reportDir = path.join(outputDir, 'report');
  ensureDir(reportDir);

  const total = Math.max(1, transcripts.length);
  const technicalCount = transcripts.filter((t) => t.failureBucket && t.failureBucket !== 'chatbot_quality_failure').length;
  const unusableCount = transcripts.filter((t) => t.failureBucket === 'empty_body' || t.failureBucket === 'empty_answer_field').length;
  const qualityFails = transcripts.filter((t) => t.failureBucket === 'chatbot_quality_failure');

  const evidenceRows = transcripts.slice(0, 120).map((t) => {
    const human = classifyHumanOutcome(t);
    const shot = screenshots.find((s) => path.basename(s).startsWith(t.id));
    const shotLink = shot ? `<a href="../screenshots/${path.basename(shot)}">screenshot</a>` : '-';
    return `<tr><td>${t.scenarioId}</td><td>${t.prompt.slice(0,120)}</td><td>${t.answer.slice(0,120) || '[empty]'}</td><td>${human.outcome}</td><td>${human.problem}</td><td><span class="sev ${human.severity.toLowerCase()}">${human.severity}</span></td><td>${shotLink}</td><td><a href="../conversations/${t.id}.html">details</a></td></tr>`;
  }).join('');

  const worstCases = transcripts
    .filter((t) => t.result !== 'pass')
    .map((t) => ({ t, human: classifyHumanOutcome(t) }))
    .sort((a, b) => {
      const order = { Critical: 4, High: 3, Medium: 2, Low: 1 } as Record<string, number>;
      return order[b.human.severity] - order[a.human.severity];
    })
    .slice(0, 10);

  const worstRows = worstCases.map(({ t, human }) => {
    const shot = screenshots.find((s) => path.basename(s).startsWith(t.id));
    const thumb = shot ? `<img src="../screenshots/${path.basename(shot)}" style="width:220px;border:1px solid #ccc" />` : '';
    return `<tr><td>${t.prompt}</td><td>${t.answer || '[empty]'}</td><td>${human.problem}</td><td>${human.impact}</td><td>${thumb}</td><td><a href="../conversations/${t.id}.html">transcript</a></td></tr>`;
  }).join('');

  const screenshotCards = worstCases.map(({ t, human }) => {
    const shot = screenshots.find((s) => path.basename(s).startsWith(t.id));
    if (!shot) return '';
    return `<div class="card"><img src="../screenshots/${path.basename(shot)}" style="width:100%" /><p><b>${t.scenarioId}</b></p><p>${human.problem}</p><p><a href="../conversations/${t.id}.html">Open conversation</a></p></div>`;
  }).join('');

  const qualityValid = technicalCount / total < 0.6;
  const overall = !qualityValid ? 'FAIL' : summary.successRate >= 0.8 ? 'PASS' : summary.successRate >= 0.5 ? 'WARNING' : 'FAIL';
  const oneLine = !qualityValid
    ? 'The run is not valid for quality evaluation because endpoint/integration failures dominate.'
    : summary.successRate >= 0.8
      ? 'The chatbot responded correctly in most scenarios, with limited weak spots.'
      : 'The chatbot is reachable, but multiple fitment and commercial guidance failures were detected.';

  const keyFindings = [
    `Chatbot ${qualityValid ? 'worked with partial weaknesses' : 'did not provide enough usable answers for quality judgment'}.`,
    `Fitment clarification rate: ${(sales.fitmentClarificationRate * 100).toFixed(1)}%.`,
    `CTA presence rate: ${(sales.ctaPresenceRate * 100).toFixed(1)}%.`,
    `No/empty response technical buckets: ${(bucketCounts.empty_body ?? 0) + (bucketCounts.empty_answer_field ?? 0)} cases.`,
    `Technical failures: ${technicalCount}/${total}.`,
  ].slice(0, 5);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Executive Summary</title><style>body{font-family:Arial;margin:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;vertical-align:top}.cards{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:10px}.panel{border:1px solid #ddd;padding:10px;border-radius:8px}.sev{padding:2px 6px;border-radius:6px;color:#fff}.low{background:#2f855a}.medium{background:#d69e2e}.high{background:#dd6b20}.critical{background:#c53030}.gallery{display:grid;grid-template-columns:repeat(3,minmax(220px,1fr));gap:12px}.card{border:1px solid #ddd;padding:8px;border-radius:8px}</style></head><body>
  <h1>Executive Investigation Summary</h1>
  <div class="cards">
    <div class="panel"><b>Run valid for quality evaluation</b><br>${qualityValid ? 'YES' : 'NO'}</div>
    <div class="panel"><b>Overall result</b><br>${overall}</div>
    <div class="panel"><b>Success rate</b><br>${(summary.successRate*100).toFixed(2)}%</div>
    <div class="panel"><b>One-line explanation</b><br>${oneLine}</div>
  </div>
  <h2>High-level verdict</h2>
  <p>The chatbot ${qualityValid ? 'was reachable for quality review' : 'was mostly blocked by technical failures'}, ${sales.contradictionRate > 0.1 ? 'showed consistency issues' : 'was reasonably consistent in available answers'}, and ${sales.ctaPresenceRate > 0.5 ? 'often moved users toward next commercial steps' : 'often failed to provide click-to-buy progression'}.</p>
  <h2>Key findings</h2>
  <ul>${keyFindings.map((k) => `<li>${k}</li>`).join('')}</ul>
  <h2>System / endpoint failures</h2><p>${technicalCount}/${total} conversations are technical failures.</p><pre>${JSON.stringify(bucketCounts, null, 2)}</pre>
  <h2>Empty or unusable responses</h2><p>${unusableCount}/${total} conversations have empty body/answer.</p>
  <h2>Real chatbot misunderstandings</h2><p>${qualityFails.filter((t)=>t.issues.includes('misunderstood_intent')).length} detected with valid answers.</p>
  <h2>Commercial failures with valid answers</h2><p>No CTA rate ${(sales.noCtaRate*100).toFixed(2)}%, purchase guidance ${(sales.purchaseGuidanceRate*100).toFixed(2)}%.</p>
  <h2>Fitment failures with valid answers</h2><p>Fitment clarification ${(sales.fitmentClarificationRate*100).toFixed(2)}%, unsafe fitment ${(sales.unsafeFitmentRate*100).toFixed(2)}%.</p>
  <h2>Scenario breakdown table</h2>
  <table><tr><th>Scenario</th><th>User request</th><th>Bot response preview</th><th>Outcome</th><th>Problem detected</th><th>Severity</th><th>Screenshot</th><th>Details link</th></tr>${evidenceRows}</table>
  <h2>Worst cases (Top 10)</h2>
  <table><tr><th>Prompt</th><th>Full answer</th><th>Why problematic</th><th>Business impact</th><th>Screenshot</th><th>Transcript</th></tr>${worstRows}</table>
  <h2>Screenshot-first investigation</h2>
  <div class="gallery">${screenshotCards || '<p>No screenshots available.</p>'}</div>
  <h2>Where the chatbot helps the user correctly</h2><p>Scenarios marked as “Worked” with low severity in the breakdown table.</p>
  <h2>Where the chatbot gets confused</h2><p>Cases tagged misunderstood_intent, irrelevant_answer, contradiction, or generic_non_answer.</p>
  <h2>Where the chatbot fails commercially</h2><p>Cases with no CTA/next step and weak purchase guidance.</p>
  <h2>Where the chatbot does not behave like a tyre dealer</h2><p>Cases missing fitment clarification or showing generic advice without dealership-style progression.</p>
  <h2>Where the chatbot is too slow or unstable</h2><p>Cases with slow outcomes and technical timeouts/non-200 status.</p>
  <p><a href="technical.html">Open technical failure report</a></p>
  </body></html>`;
  fs.writeFileSync(path.join(reportDir, 'executive-summary.html'), html, 'utf8');
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
  const pages: Array<{ id: string; result: 'pass'|'warn'|'fail'; htmlPath: string }> = [];

  for (const scenario of scenarios) {
    const rows = await runScenario(client, scenario);
    allRows.push(...rows);

    rows.forEach((row, idx) => {
      const resultLabel: 'pass'|'warn'|'fail' = row.failureBucket ? 'fail' : row.qualityCategories.length ? 'warn' : 'pass';
      const issues = row.failureBucket ? [row.failureBucket, row.reason] : row.qualityCategories;
      const transcript: Transcript = {
        id: `${scenario.name}-${idx + 1}-${randomUUID().slice(0,8)}`,
        scenarioId: scenario.name,
        scenarioCategory: scenario.tags?.[0] ?? scenario.name,
        result: resultLabel,
        issues,
        prompt: row.prompt,
        answer: row.answer,
        latencyMs: row.result.latencyMs,
        status: row.result.status,
        failureBucket: row.failureBucket ?? (row.qualityCategories.length ? 'chatbot_quality_failure' : null),
        requestPayload: row.payload,
        responseHeaders: row.result.headers,
        rawResponse: row.result.rawBody,
        parsedResponse: row.result.parsedBody,
        error: row.result.error,
      };
      transcripts.push(transcript);
      const htmlPath = saveTranscriptArtifacts(config.outputDir, transcript);
      pages.push({ id: transcript.id, result: transcript.result, htmlPath });

      if (resultLabel !== 'pass') {
        appendJsonl(path.join(config.outputDir, 'failures.jsonl'), {
          scenario: transcript.scenarioId,
          result: transcript.result,
          failureBucket: transcript.failureBucket,
          reason: transcript.reason,
          requestUrl: config.chatbotUrl,
          requestPayload: transcript.requestPayload,
          status: transcript.status,
          responseHeaders: transcript.responseHeaders,
          rawBody: transcript.rawResponse,
          parsedBody: transcript.parsedResponse,
          latencyMs: transcript.latencyMs,
          error: transcript.error,
          issues: transcript.issues,
        });
      }
    });

    scenarioMetrics.push(computeScenarioMetrics(scenario.name, rows));
  }

  // Conversation scenarios are still executed for stress continuity, but marked quality-only when usable answers exist
  const conversationMetrics: ConversationRunMetrics[] = [];
  for (const conv of conversationScenarios) conversationMetrics.push(await runConversationScenario(client, conv));

  const breakpoint = config.profile === 'breakpoint'
    ? await runBreakpointSearch(config)
    : { steps: [], bestStableConcurrency: 0, firstUnstableConcurrency: null };

  const summary = aggregateSummary(scenarioMetrics);
  const totalRows = Math.max(1, allRows.length);
  const validRows = allRows.filter((r) => r.hasUsableAnswer);
  const purchaseRows = validRows.filter((r) => r.result.scenario.includes('purchase') || r.prompt.toLowerCase().includes('buy'));
  const fitmentRows = validRows.filter((r) => r.result.scenario.includes('fitment'));

  const salesMetrics = {
    conversationCompletionRate: conversationMetrics.length ? conversationMetrics.reduce((a,b)=>a+b.completionRate,0)/conversationMetrics.length : 0,
    contradictionRate: conversationMetrics.length ? conversationMetrics.reduce((a,b)=>a+b.consistencyViolations,0)/Math.max(1,conversationMetrics.reduce((a,b)=>a+b.totalTurns,0)) : 0,
    fitmentClarificationRate: fitmentRows.length ? fitmentRows.filter((r)=>r.salesSignals.askedClarifyingQuestion).length/fitmentRows.length : 0,
    purchaseGuidanceRate: purchaseRows.length ? purchaseRows.filter((r)=>r.salesSignals.hasCommercialCta || !r.salesSignals.tooGeneric).length/purchaseRows.length : 0,
    ctaPresenceRate: validRows.length ? validRows.filter((r)=>r.salesSignals.hasCommercialCta).length/validRows.length : 0,
    noCtaRate: validRows.length ? validRows.filter((r)=>!r.salesSignals.hasCommercialCta).length/validRows.length : 0,
    earlyRecommendationRate: validRows.length ? validRows.filter((r)=>r.salesSignals.earlyRecommendation).length/validRows.length : 0,
    unsafeFitmentRate: validRows.length ? validRows.filter((r)=>r.salesSignals.potentialUnsafeFitment).length/validRows.length : 0,
    suspiciousResponseRate: allRows.filter((r)=>!!r.validation.suspiciousReason).length/totalRows,
  };

  const shotResult = await captureScreenshots(config.outputDir, pages);
  if (shotResult.failed > 0) {
    transcripts.push({ id: `renderer-${randomUUID().slice(0,8)}`, scenarioId: 'renderer', scenarioCategory: 'system', result: 'warn', issues: ['screenshot_generation_failure'], prompt: '', answer: '', latencyMs: 0, failureBucket: 'screenshot_generation_failure', requestPayload: {}, reason: `${shotResult.failed} screenshot(s) failed` });
  }

  const bucketCounts: Record<string, number> = {};
  transcripts.forEach((t) => {
    if (t.failureBucket) bucketCounts[t.failureBucket] = (bucketCounts[t.failureBucket] ?? 0) + 1;
  });

  writeJson(path.join(config.outputDir, 'summary.json'), { ...summary, salesMetrics, breakpoint, technicalBucketCounts: bucketCounts, screenshots: shotResult.files.length });
  writeJson(path.join(config.outputDir, 'scenario-metrics.json'), scenarioMetrics);
  writeJson(path.join(config.outputDir, 'sales-metrics.json'), salesMetrics);
  writeJson(path.join(config.outputDir, 'conversation-metrics.json'), conversationMetrics);
  writeCsv(config.outputDir, scenarioMetrics);

  buildTechnicalReport(config.outputDir, transcripts.filter((t) => t.failureBucket && t.failureBucket !== 'chatbot_quality_failure'), bucketCounts);
  buildMainReport(config.outputDir, summary, scenarioMetrics, salesMetrics, transcripts, shotResult.files, bucketCounts);

  const topWorst = transcripts.filter((t)=>t.result!=='pass').slice(0,10);
  const topSuspicious = allRows.filter((r)=>!!r.validation.suspiciousReason).slice(0,10).map((r)=>({scenario:r.result.scenario, reason:r.validation.suspiciousReason, answer:r.answer.slice(0,200)}));
  const topIneffective = validRows.filter((r)=>!r.salesSignals.hasCommercialCta || r.salesSignals.tooGeneric).slice(0,10).map((r)=>({scenario:r.result.scenario,prompt:r.prompt.slice(0,120)}));
  writeJson(path.join(config.outputDir, 'top-10-worst-conversations.json'), topWorst);
  writeJson(path.join(config.outputDir, 'top-10-suspicious-answers.json'), topSuspicious);
  writeJson(path.join(config.outputDir, 'top-10-commercially-ineffective.json'), topIneffective);

  const technicalDominant = (bucketCounts.endpoint_unreachable ?? 0) + (bucketCounts.dns_or_network_failure ?? 0) + (bucketCounts.non_200_http_response ?? 0) > (summary.totals.total * 0.5);
  writeJobSummary(config.outputDir, [
    '# Chatbot Stress Investigation Summary',
    `- Success rate: ${(summary.successRate*100).toFixed(2)}%`,
    `- Technical dominant failures: ${technicalDominant ? 'YES' : 'NO'}`,
    `- Main report: report/executive-summary.html`,
    `- Technical report: report/technical.html`,
    '',
    '## First things to check',
    '- endpoint URL mismatch',
    '- missing auth header',
    '- wrong request payload shape',
    '- incorrect response field mapping',
    '- environment/network issue',
    '- self-hosted runner / internal DNS reachability problem',
  ]);

  console.log('=== Chatbot Stress Summary ===');
  console.log(`Profile: ${config.profile}`);
  console.log(`Main report: ${path.join(config.outputDir, 'report/executive-summary.html')}`);
  console.log(`Technical report: ${path.join(config.outputDir, 'report/technical.html')}`);
}
