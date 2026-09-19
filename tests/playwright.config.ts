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
    { name: 'chromium', testMatch: ['**/*.spec.ts'] },
    // The MSE spec is the one place engine differences matter (MediaSource + fMP4 support).
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /v2-mse-playback/ },
    {
      // Playwright's Firefox build has no AAC decoder here, so that case asserts the byte-range
      // index is accepted and skips the timing assertions with a note.
      name: 'firefox',
      // Only the MSE spec is engine-aware for now; the app specs were written for Chromium.
      testMatch: /v2-mse-playback/,
      use: { browserName: 'firefox', launchOptions: { env: { ...process.env, CUBEB_BACKEND: 'squibb' } } },
    },
  ],

  reporter: process.env.CI ? [['github'], ['list']] : [[process.env.PLAYWRIGHT_HTML === 'true' ? 'html' : 'line']],

  webServer: {
    // Start Vite dev server. From tests/ dir, '..' resolves to muzsikapp root,
    // where the frontend project lives as a sibling directory.
    // From tests/ the app root is '..', and frontend/ sits inside it.
    command: 'cd .. && node ./frontend/node_modules/.bin/vite --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: process.env.CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },

});
