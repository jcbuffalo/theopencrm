// Customer-Success (CS-1 / CS-3) e2e + a11y walker for The Open CRM.
//
// ============================================================================
// PREREQUISITES — read before wiring this into a real run
// ============================================================================
// These routes are NOT visible on a vanilla / generic org. They only render
// when ALL of the following hold for the TEST_USER's org:
//
//   1. The Customer-Success module is DEPLOYED to the target baseURL
//      (migrations 095_account_health.sql + 096_renewals.sql applied, and the
//      CS routes — backend/routes/accountRoutes.js GET /:companyId/360 and
//      backend/routes/serviceContractRoutes.js GET /renewals — mounted).
//   2. The org has the `customer_success_enabled` feature flag ON. Every CS
//      backend route is gated by it (see backend/services/featureFlags.js); a
//      403 means the flag is off. Manage at /admin/feature-flags.
//   3. The org runs a profile whose stage config sets
//      `showAccountManagement: true` — today that's `zang` or `rin`
//      (see frontend/src/stages.js getStageConfig). On any other profile the
//      SPA does not even register the /accounts/:id and /renewals routes
//      (frontend/src/App.js gates them behind `showAccountManagement`), so the
//      paths fall through to the SPA catch-all and you'd audit the wrong page.
//   4. CS_ACCOUNT_ID is set to a real company id in that org so /accounts/:id
//      resolves to a populated 360 view rather than an empty/not-found state.
//      Defaults to '1' if unset.
//
// Because of (3) this file MUST run against a zang/rin org. The default mobile
// audit credentials point at a generic dogfood org; running this with those
// creds will surface a `cs-route-not-rendered` finding (the SPA redirected /
// 404'd the gated route) rather than a real CS audit. That finding is the
// intended signal, not a false failure — it tells the nightly the test creds
// aren't pointed at a CS-enabled org.
//
// For each (viewport × route) we check the same surface mobile.spec.js does:
//   1. Page loads HTTP 2xx
//   2. No JavaScript console errors during load
//   3. No horizontal scroll
//   4. axe-core WCAG 2.1 A + AA scan
//   5. Full-page screenshot artifact
//
// All tests are tagged @auth and skip when TEST_USER_EMAIL + TEST_USER_PASSWORD
// are unset. Auth uses the same single-login cookie cache as mobile.spec.js
// (written by global-setup.js to .auth/cookies.json). This is a CI artifact for
// the Playwright nightly — it shares MOBILE_TEST_FINDINGS.json so its findings
// land alongside the mobile walker's in the same nightly report.

const { test } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
const path = require('path');

// Real company id in the CS-enabled test org. /accounts/:id needs a concrete
// id; '1' is a sane default for the dogfood org but should be overridden in CI
// to a company that actually has a service contract + activity so the 360 view
// and renewal board render with data.
const CS_ACCOUNT_ID = process.env.CS_ACCOUNT_ID || '1';

const CS_ROUTES = [
  { path: `/accounts/${CS_ACCOUNT_ID}`, name: 'account-360' },
  { path: '/renewals',                  name: 'renewals' },
];

// Findings accumulate in a module-level array and are MERGED into the shared
// MOBILE_TEST_FINDINGS.json in afterAll (read-concat-write), mirroring
// mobile.spec.js so the nightly report aggregates both walkers. workers:1 in
// the config keeps the merge race-free.
const findings = [];

function logFinding(severity, viewport, route, kind, detail) {
  findings.push({ severity, viewport, route, kind, detail });
}

// Populated from .auth/cookies.json (written once by global-setup.js).
let cachedAuthCookies = null;
let authError = null;

(() => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.auth', 'cookies.json'), 'utf8');
    const parsed = JSON.parse(raw);
    cachedAuthCookies = parsed.cookies || null;
    authError = parsed.error || (cachedAuthCookies ? null : 'no cookies in .auth/cookies.json');
  } catch (e) {
    authError = `could not read .auth/cookies.json — did globalSetup run? (${String(e).slice(0, 120)})`;
  }
})();

async function auditPage(page, viewport, route, projectName) {
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  // 'domcontentloaded' not 'networkidle': the SPA keeps background XHRs alive
  // (auth/session probes, data refresh) so networkidle may never settle. Give
  // the SPA a beat to hydrate + paint its first data fetch.
  const response = await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(e => {
    logFinding('🔴', projectName, route.name, 'navigation-failed', String(e).slice(0, 200));
    return null;
  });
  await page.waitForTimeout(1500);

  if (!response) return;
  if (response.status() >= 400) {
    logFinding('🔴', projectName, route.name, 'http-error', `HTTP ${response.status()}`);
    return;
  }

  // Detect the "gated route not rendered" case. When the test org isn't on a
  // zang/rin profile (showAccountManagement=false), App.js never registers
  // these routes, so the SPA catch-all redirects to the dashboard/landing. The
  // returned document is still HTTP 200 (the SPA shell), so a status check
  // can't catch it — we look for a CS-specific marker in the rendered DOM and
  // flag its absence as a 🟠 (prereq not met) rather than silently auditing
  // the wrong page. The CS pages render distinctive copy ("360" header on the
  // account page, "Renewals"/"At risk" board on the renewals page).
  const looksLikeCsPage = await page.evaluate((routeName) => {
    const txt = (document.body.innerText || '').toLowerCase();
    if (routeName === 'renewals') {
      return txt.includes('renewal') || txt.includes('at risk') || txt.includes('upcoming');
    }
    // account-360
    return txt.includes('360') || txt.includes('timeline')
      || txt.includes('open task') || txt.includes('health');
  }, route.name).catch(() => false);

  if (!looksLikeCsPage) {
    logFinding('🟠', projectName, route.name, 'cs-route-not-rendered',
      'CS page markers not found — test org likely lacks customer_success_enabled '
      + 'or a zang/rin profile, or the CS module is not deployed to this baseURL. '
      + 'See the prerequisites header in customer-success.spec.js.');
    // Still capture a screenshot below so a human can see what rendered.
  }

  // Screenshot regardless of outcome. Full-page first; fall back to viewport.
  const screenshotPath = path.join('playwright-artifacts', `cs--${projectName}--${route.name}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (e1) {
    try {
      await page.screenshot({ path: screenshotPath, fullPage: false });
      logFinding('🟡', projectName, route.name, 'screenshot-fullpage-fallback', String(e1).slice(0, 120));
    } catch (e2) {
      logFinding('🟠', projectName, route.name, 'screenshot-failed', String(e2).slice(0, 120));
    }
  }

  // 1. Console errors (cap to 3 to avoid drowning the report)
  if (consoleErrors.length > 0) {
    for (const err of consoleErrors.slice(0, 3)) {
      logFinding('🟠', projectName, route.name, 'console-error', err.slice(0, 200));
    }
  }

  // 2. Horizontal scroll, with widest-offender diagnosis so it's actionable.
  const hasHorizontalScroll = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  });
  if (hasHorizontalScroll) {
    const overflow = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const right = rect.x + rect.width;
        if (right > cw + 1) {
          const cs = window.getComputedStyle(el);
          const isFixed = cs.position === 'fixed' || cs.position === 'sticky';
          const id = el.id ? `#${el.id}` : '';
          const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '';
          offenders.push({
            tag: el.tagName.toLowerCase(),
            sel: `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120),
            text: (el.textContent || '').trim().slice(0, 60),
            w: Math.round(rect.width),
            overflow: Math.round(right - cw),
            isFixed,
          });
        }
      }
      offenders.sort((a, b) => {
        if (a.isFixed !== b.isFixed) return a.isFixed ? 1 : -1;
        return b.overflow - a.overflow;
      });
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: cw,
        worst: offenders[0] || null,
      };
    });
    const w = overflow.worst;
    const culprit = w
      ? ` worst: <${w.tag}>${w.isFixed ? '[FIXED]' : ''} "${w.text}" w=${w.w}px overflow=${w.overflow}px sel=${w.sel}`
      : '';
    logFinding('🔴', projectName, route.name, 'horizontal-scroll',
      `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} overflow=${overflow.scrollWidth - overflow.clientWidth}px${culprit}`);
  }

  // 3. WCAG 2.1 A + AA accessibility scan. Cap to 8 violations per page.
  try {
    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of axe.violations.slice(0, 8)) {
      const sev = v.impact === 'critical' || v.impact === 'serious' ? '🔴'
                : v.impact === 'moderate' ? '🟠'
                : '🟡';
      const targets = (v.nodes || []).slice(0, 2)
        .map(n => (n.target || []).join(' > ').slice(0, 80))
        .filter(Boolean)
        .join(' | ');
      logFinding(sev, projectName, route.name, `a11y-${v.id}`,
        `${v.impact || 'minor'}: ${v.help} — ${v.nodes.length} node(s)${targets ? ` (${targets})` : ''} — ${v.helpUrl}`);
    }
  } catch (e) {
    logFinding('🟠', projectName, route.name, 'a11y-scan-failed', String(e).slice(0, 200));
  }
}

const hasCreds = !!(process.env.TEST_USER_EMAIL && process.env.TEST_USER_PASSWORD);

test.describe.parallel('Customer-Success audit', () => {
  for (const route of CS_ROUTES) {
    test(`@auth ${route.name}`, async ({ page, context }, testInfo) => {
      test.skip(!hasCreds, 'TEST_USER_EMAIL + TEST_USER_PASSWORD not set');
      if (authError || !cachedAuthCookies) {
        logFinding('🔴', testInfo.project.name, route.name, 'auth-login-failed',
          `${authError || 'no cached cookies'} — check TEST_USER_EMAIL / TEST_USER_PASSWORD secrets`);
        return;
      }
      // Re-apply the single-login cookies to this test's fresh context.
      await context.addCookies(cachedAuthCookies);
      // Pre-accept the first-session Terms gate (localStorage flag, see
      // TermsModal.js) so the modal doesn't overlay the page we want to audit.
      await context.addInitScript(() => {
        try {
          localStorage.setItem('theopencrm.terms.accepted.v1', 'true');
          localStorage.setItem('theopencrm.terms.accepted_at.v1', new Date().toISOString());
        } catch { /* private mode, ignore */ }
      });
      // Mock the ambient auth/feature-probe endpoints so rate-limit pressure
      // across viewports can't flip the SPA into its unauth tree. IMPORTANT:
      // org_profile is mocked as 'zang' here so App.js registers the CS routes
      // — these surfaces only mount when showAccountManagement is true. Real
      // data XHRs (/accounts/:id/360, /service-contracts/renewals) pass through
      // untouched so we still exercise the live backend. If the backend org
      // lacks customer_success_enabled those calls 403 and the page renders its
      // empty/error state — which the cs-route-not-rendered check will surface.
      await context.route('**/api/auth/me', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          user: {
            id: 7, email: 'crm-tester@theopencrm.com', name: 'Automation Tester',
            status: 'active', org_id: 1, org_role: 'admin', org_profile: 'zang',
            org_name: 'CS Audit Org',
            org_branding: {}, org_tier: 'pro',
            notification_preferences: {}, notification_email: null, notification_phone: null,
            is_admin: false, admin_role: null, admin_permissions: [],
          },
        }),
      }));
      await context.route('**/api/auth/csrf', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ csrfToken: 'audit-mock-csrf-token' }),
      }));
      await context.route('**/api/ai/status', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configured: false, message: 'mocked: AI not configured (audit)' }),
      }));
      await auditPage(page, testInfo.project.use.viewport, route, testInfo.project.name);
    });
  }
});

test.afterAll(async () => {
  // MERGE into the shared findings file (read-concat-write). global-setup.js
  // zeroes the file once at run start; mobile.spec.js + this spec both append.
  // workers:1 + fullyParallel:false make the projects sequential, so the merge
  // is race-free.
  const outPath = path.join(__dirname, 'MOBILE_TEST_FINDINGS.json');
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (!Array.isArray(existing)) existing = [];
  } catch { existing = []; }
  fs.writeFileSync(outPath, JSON.stringify(existing.concat(findings), null, 2));
});
