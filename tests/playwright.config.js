// Mobile-focused Playwright config for The Open CRM.
// Runs the same spec across multiple mobile viewports + a tablet.
// Authenticated routes require TEST_USER_EMAIL + TEST_USER_PASSWORD env vars
// (and an account that's already been approved past the access-request gate).

const { defineConfig, devices } = require('@playwright/test');

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://app.theopencrm.com';

module.exports = defineConfig({
  testDir: '.',
  // Logs in exactly once (before any worker) and writes cookies to .auth/.
  // Keeps the whole run to a single /auth/login hit so the 30/15min auth
  // rate limiter is never a factor. See global-setup.js for the full why.
  globalSetup: require.resolve('./global-setup.js'),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // workers:1 + fullyParallel:false — the audit walker accumulates findings
  // in a single module-level array dumped in afterAll. With multiple worker
  // processes each keeps its own array and the last afterAll write clobbers
  // the rest, losing findings. Single-worker keeps the findings JSON whole.
  // The suite is ~95 tests at ~0.5s each = ~2min single-threaded, acceptable
  // for an on-demand / nightly audit.
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'playwright-artifacts',
  use: {
    baseURL: BASE_URL,
    // Screenshots: capture EVERY test, not just failures. The mobile.spec.js
    // walker already writes its own full-page PNG per (route × viewport) into
    // playwright-artifacts/; this 'on' setting adds Playwright's own
    // per-test screenshot too (smaller, useful for the HTML report's
    // step-by-step gallery).
    screenshot: 'on',
    // Videos still only on failure — they're large and not useful for the
    // happy path. To enable everywhere change to 'on'.
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: false,
  },
  // We force Chromium across all device profiles because that's what we have
  // installed locally (skipping the 400MB webkit + firefox install). Chromium
  // emulating iPhone/iPad catches layout / viewport / overflow issues; for
  // Safari-specific quirks (e.g. -webkit-overflow-scrolling, fixed-position
  // glitches) install webkit via `npx playwright install webkit` and remove
  // the browserName overrides below.
  projects: [
    { name: 'iphone-se',       use: { ...devices['iPhone SE'],            browserName: 'chromium' } }, // 375 x 667
    { name: 'iphone-14-pro',   use: { ...devices['iPhone 14 Pro'],        browserName: 'chromium' } }, // 393 x 852
    { name: 'pixel-5',         use: { ...devices['Pixel 5'] } },                                       // 393 x 851
    { name: 'ipad-portrait',   use: { ...devices['iPad Mini'],            browserName: 'chromium' } }, // 768 x 1024
    { name: 'ipad-landscape',  use: { ...devices['iPad Mini landscape'],  browserName: 'chromium' } }, // 1024 x 768
  ],
});
