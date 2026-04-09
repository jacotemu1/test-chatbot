import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { runHarness } from '../src/runner';
import { loadConfig } from '../src/config';

test.describe('Chatbot robustness harness', () => {
  test('Smoke + stress scenarios produce artifacts and summary', async () => {
    const config = loadConfig();
    await runHarness();

    const summaryPath = path.join(config.outputDir, 'summary.json');
    const scenarioPath = path.join(config.outputDir, 'scenario-metrics.json');
    const failuresPath = path.join(config.outputDir, 'failures.jsonl');

    expect(fs.existsSync(summaryPath)).toBeTruthy();
    expect(fs.existsSync(scenarioPath)).toBeTruthy();

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
      successRate: number;
      totals: { total: number };
    };

    expect(summary.totals.total).toBeGreaterThan(0);
    expect(summary.successRate).toBeGreaterThanOrEqual(0);
    expect(summary.successRate).toBeLessThanOrEqual(1);

    if (fs.existsSync(failuresPath)) {
      const lines = fs.readFileSync(failuresPath, 'utf8').trim().split('\n').filter(Boolean);
      expect(Array.isArray(lines)).toBeTruthy();
    }
  });
});
