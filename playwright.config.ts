import { defineConfig } from '@playwright/test';
import { loadConfig } from './src/config';

const cfg = loadConfig();

export default defineConfig({
  testDir: './tests',
  timeout: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${cfg.outputDir}/playwright-html`, open: 'never' }],
    ['json', { outputFile: `${cfg.outputDir}/playwright-report.json` }],
    ['junit', { outputFile: `${cfg.outputDir}/junit.xml` }],
  ],
  use: {
    trace: 'off',
  },
});
