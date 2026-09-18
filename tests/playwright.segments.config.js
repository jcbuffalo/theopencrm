// Dedicated Playwright config for the self-contained /segments UI review.
// No globalSetup/login: it serves the LOCAL production build via `vite preview`
// and the spec stubs every API call. baseURL points at the preview server.

const { defineConfig } = require('@playwright/test');
const path = require('path');

const PORT = 4319;
const FRONTEND = path.join(__dirname, '..', 'frontend');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'segments-ui-review.spec.js',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: path.join(__dirname, 'segments-ui-artifacts', '_pw'),
  use: {
    baseURL: `http://localhost:${PORT}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  webServer: {
    // vite preview serves build.outDir (build/) with SPA history fallback.
    command: `npm run preview -- --port ${PORT} --strictPort`,
    cwd: FRONTEND,
    url: `http://localhost:${PORT}/`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
