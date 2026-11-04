import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/security-browser.spec.mjs',
  workers: 1, retries: 0,
  outputDir: '.quota-reports/security-browser',
  reporter: 'list',
  use: { baseURL: process.env.SECURITY_UI_URL ?? 'http://127.0.0.1:3017', screenshot: 'only-on-failure', trace: 'off' },
});
