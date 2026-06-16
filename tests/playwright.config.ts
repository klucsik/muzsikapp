import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium' },
    // firefox and webkit browsers are cached but may not start reliably in headless container; add when needed.
  ],

  reporter: process.env.CI ? [['github'], ['list']] : [[process.env.PLAYWRIGHT_HTML === 'true' ? 'html' : 'line']],

  webServer: {
    // Start Vite dev server. From tests/ dir, '..' resolves to muzsikapp root,
    // where the frontend project lives as a sibling directory.
    command: 'cd .. && node ../frontend/node_modules/.bin/vite --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: process.env.CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },

});
