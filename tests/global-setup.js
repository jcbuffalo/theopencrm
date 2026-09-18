// Global setup — runs ONCE per `npx playwright test` invocation, before any
// worker process starts. We log in a single time here and persist the
// resulting cookies to disk. The spec's @auth tests load those cookies into
// each fresh browser context (via context.addCookies) instead of logging in
// themselves.
//
// Why this exists: a top-level test.beforeAll runs once PER PROJECT, and
// Playwright recycles the worker process between our 5 viewport projects, so
// module-level memoization doesn't survive. That meant ~5 logins per run,
// which repeatedly tripped the backend auth rate limiter (30/15min/IP) on the
// 5th project. globalSetup is the one place guaranteed to run exactly once, so
// a single login here keeps every run to one /auth/login hit no matter how
// many projects × routes we walk.
//
// Note: we deliberately do NOT wire these cookies into config use.storageState,
// because that would also apply them to the @public tests (landing, /login)
// which must be exercised logged-OUT. The spec applies them per-test, @auth
// only.

const { request } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BACKEND_URL = (process.env.PLAYWRIGHT_BACKEND_URL
  || 'https://synccrm-backend-615440681743.us-central1.run.app').replace(/\/$/, '');

const AUTH_DIR = path.join(__dirname, '.auth');
const COOKIES_FILE = path.join(AUTH_DIR, 'cookies.json');

module.exports = async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Reset the findings file to a clean slate for this run. The spec's afterAll
  // MERGES into this file (read-concat-write) rather than overwriting, because
  // Playwright recycles the worker process between our 5 viewport projects —
  // even at workers:1 — so the spec's module-level findings array resets each
  // project. A plain overwrite in afterAll would leave only the LAST project's
  // findings. globalSetup runs exactly once, so it's the right place to zero it.
  fs.writeFileSync(path.join(__dirname, 'MOBILE_TEST_FINDINGS.json'), '[]');

  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;

  // No creds → write an explicit error marker so the spec can skip/report
  // rather than silently treating "logged out" as a pass.
  if (!email || !password) {
    fs.writeFileSync(COOKIES_FILE, JSON.stringify({
      cookies: null,
      error: 'TEST_USER_EMAIL + TEST_USER_PASSWORD not set',
    }));
    return;
  }

  const ctx = await request.newContext();
  try {
    const res = await ctx.post(`${BACKEND_URL}/api/auth/login`, {
      data: { email, password },
      headers: { Origin: process.env.PLAYWRIGHT_BASE_URL || 'https://app.theopencrm.com' },
    });
    if (!res.ok()) {
      const body = await res.text().catch(() => '');
      fs.writeFileSync(COOKIES_FILE, JSON.stringify({
        cookies: null,
        error: `POST ${BACKEND_URL}/api/auth/login returned ${res.status()}${body ? ` — ${body.slice(0, 120)}` : ''}`,
      }));
    } else {
      const state = await ctx.storageState();
      fs.writeFileSync(COOKIES_FILE, JSON.stringify({
        cookies: state.cookies,
        error: null,
      }));
    }
  } catch (e) {
    fs.writeFileSync(COOKIES_FILE, JSON.stringify({
      cookies: null,
      error: String(e).slice(0, 200),
    }));
  } finally {
    await ctx.dispose();
  }
};
