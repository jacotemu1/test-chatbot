import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import dataset from '../fixtures/scenario-dataset.it.json';
import { runHarness } from '../src/runner';
import { loadConfig } from '../src/config';
import { ScenarioFixtureEntry, ValidationMode } from '../src/types';

const supportedModes: ValidationMode[] = [
  'non_empty',
  'keyword_match',
  'schema_only',
  'latency_only',
  'safety_check',
  'consistency_check',
];

test.describe('Chatbot robustness harness', () => {
  test('fixture dataset quality gates', async () => {
    const entries = dataset as ScenarioFixtureEntry[];
    expect(entries.length).toBeGreaterThanOrEqual(60);

    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.prompt).not.toBeUndefined();
      expect(entry.expectedMinimumBehavior).toBeTruthy();
      expect(supportedModes.includes(entry.validationMode)).toBeTruthy();
      expect(entry.severity).toMatch(/low|medium|high|critical/);
      expect(Array.isArray(entry.tags)).toBeTruthy();
    }
  });

  test('harness produces investigation artifacts', async () => {
    const config = loadConfig();
    await runHarness();

    const summaryPath = path.join(config.outputDir, 'summary.json');
    const scenarioPath = path.join(config.outputDir, 'scenario-metrics.json');
    const failuresPath = path.join(config.outputDir, 'failures.jsonl');
    const salesMetricsPath = path.join(config.outputDir, 'sales-metrics.json');
    const reportIndexPath = path.join(config.outputDir, 'report', 'index.html');
    const conversationsDir = path.join(config.outputDir, 'conversations');
    const jobSummaryPath = path.join(config.outputDir, 'job-summary.md');

    expect(fs.existsSync(summaryPath)).toBeTruthy();
    expect(fs.existsSync(scenarioPath)).toBeTruthy();
    expect(fs.existsSync(salesMetricsPath)).toBeTruthy();
    expect(fs.existsSync(reportIndexPath)).toBeTruthy();
    expect(fs.existsSync(conversationsDir)).toBeTruthy();
    expect(fs.existsSync(jobSummaryPath)).toBeTruthy();

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { successRate: number; totals: { total: number } };
    expect(summary.totals.total).toBeGreaterThan(0);
    expect(summary.successRate).toBeGreaterThanOrEqual(0);
    expect(summary.successRate).toBeLessThanOrEqual(1);

    if (fs.existsSync(failuresPath)) {
      const lines = fs.readFileSync(failuresPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(Array.isArray(lines)).toBeTruthy();
    }
  });
});
