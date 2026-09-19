// Mobile-friendliness audit for The Open CRM.
//
// For each (viewport × route) combination we check:
//   1. Page loads with HTTP 2xx
//   2. No JavaScript console errors during load
//   3. No horizontal scroll (page.scrollWidth <= viewport.clientWidth + 1)
//   4. Every interactive element is at least 32x32 (WCAG minimum is 24; Apple
//      HIG recommends 44; we flag <32 as definitely too small)
//   5. Capture a screenshot so a human can eyeball
//
// Public-route tests run without auth. Authenticated-route tests are tagged
// @auth and only run when TEST_USER_EMAIL + TEST_USER_PASSWORD are set.

const { test } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
const path = require('path');

const PUBLIC_ROUTES = [
  { path: '/',                      name: 'landing' },
  { path: '/login',                 name: 'login' },
  { path: '/privacy',               name: 'privacy' },
  { path: '/terms',                 name: 'terms' },
  { path: '/legal/dpa',             name: 'legal-dpa' },
  { path: '/legal/subprocessors',   name: 'legal-subprocessors' },
];

const AUTH_ROUTES = [
  { path: '/',                       name: 'dashboard' },
  { path: '/companies',              name: 'companies' },
  { path: '/contacts',               name: 'contacts' },
  // Contact record drawer (Wave 2). Id 1 may 404 on a fresh org — the drawer
  // then renders its error state, which is still a valid phone layout to audit.
  { path: '/contacts/1',             name: 'contact-record' },
  { path: '/deals',                  name: 'deals' },
  { path: '/activities',             name: 'activities' },
  { path: '/tasks',                  name: 'tasks' },
  { path: '/quotes',                 name: 'quotes' },
  { path: '/reports',                name: 'reports' },
  { path: '/settings',               name: 'settings-profile' },
  { path: '/settings#privacy',       name: 'settings-privacy' },
  { path: '/settings#notifications', name: 'settings-notifications' },
  { path: '/settings#legal',         name: 'settings-legal' },
  { path: '/usage',                  name: 'usage' },
  { path: '/today',                  name: 'today' },
  { path: '/calendar',               name: 'calendar' },
  { path: '/leads',                  name: 'leads' },
  { path: '/notifications',          name: 'notifications' },
  { path: '/sequences',              name: 'sequences' },
];

// Auth note: the single login is performed in global-setup.js against the
// BACKEND Cloud Run service (the SPA calls *.run.app baked into the build;
// posting auth to the frontend domain 404s — it only serves the SPA shell).
// Those cookies (sameSite=none) are written to .auth/cookies.json and the
// @auth tests load them into each fresh context so the page's XHRs to the
// backend carry the session.

// Findings collected across all tests, dumped at the end. NOTE: the config
// pins workers:1 so this single module-level array is the whole picture —
// with parallel workers each process keeps its own array and the afterAll
// write clobbers the others, losing findings.
const findings = [];

function logFinding(severity, viewport, route, kind, detail) {
  findings.push({ severity, viewport, route, kind, detail });
}

// Populated below from .auth/cookies.json (written by global-setup.js).
// authError holds the login failure detail (if any) so each @auth test can
// log a finding instead of silently passing.
let cachedAuthCookies = null;
let authError = null;

async function auditPage(page, viewport, route, projectName) {
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  // 'domcontentloaded' not 'networkidle': authenticated SPA pages make
  // ongoing background XHRs (dashboard refresh, usage polling, chat session
  // probes) so networkidle may never settle and goto would time out. We then
  // give the SPA a moment to render + settle its initial data fetch.
  const response = await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(e => {
    logFinding('🔴', projectName, route.name, 'navigation-failed', String(e).slice(0, 200));
    return null;
  });
  await page.waitForTimeout(1500); // let the SPA hydrate + first data fetch paint

  if (!response) return;
  if (response.status() >= 400) {
    logFinding('🔴', projectName, route.name, 'http-error', `HTTP ${response.status()}`);
    return;
  }

  // Capture screenshot regardless of outcome. Try full-page first; if that
  // fails (very tall authenticated pages occasionally error on fullPage),
  // fall back to a viewport screenshot and log the degradation rather than
  // silently producing no image.
  const screenshotPath = path.join('playwright-artifacts', `${projectName}--${route.name}.png`);
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

  // 1. Console errors
  if (consoleErrors.length > 0) {
    for (const err of consoleErrors.slice(0, 3)) {
      logFinding('🟠', projectName, route.name, 'console-error', err.slice(0, 200));
    }
  }

  // 2. Horizontal scroll
  const hasHorizontalScroll = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  });
  if (hasHorizontalScroll) {
    // Also identify the WIDEST offending element so the finding is actionable
    // (just "page is too wide" can't be fixed without knowing what's wide).
    // We walk every element, find ones whose right edge exceeds the document
    // clientWidth, sort by overflow amount, and report the top one + a
    // selector hint the developer can grep for.
    const overflow = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const right = rect.x + rect.width;
        if (right > cw + 1) {
          // position:fixed elements anchor to the initial containing block,
          // but when the document scrollWidth is already > viewport, those
          // elements track the wider document via inset-x-0 — they show up as
          // the widest offender even though they're SYMPTOMS, not causes.
          // Tag them so we can prefer non-fixed culprits when reporting.
          const cs = window.getComputedStyle(el);
          const isFixed = cs.position === 'fixed' || cs.position === 'sticky';
          // Build a short selector hint.
          const id = el.id ? `#${el.id}` : '';
          const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
            : '';
          offenders.push({
            tag: el.tagName.toLowerCase(),
            sel: `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 120),
            text: (el.textContent || '').trim().slice(0, 60),
            w: Math.round(rect.width),
            right: Math.round(right),
            overflow: Math.round(right - cw),
            isFixed,
          });
        }
      }
      // Prefer non-fixed culprits — they're the ROOT cause; fixed elements just
      // track the wider document. Sort: non-fixed first, then by overflow desc.
      offenders.sort((a, b) => {
        if (a.isFixed !== b.isFixed) return a.isFixed ? 1 : -1;
        return b.overflow - a.overflow;
      });
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: cw,
        worst: offenders[0] || null,
        worstFixed: offenders.find(o => o.isFixed) || null,
      };
    });
    const w = overflow.worst;
    const wf = overflow.worstFixed;
    const culprit = w
      ? ` worst: <${w.tag}>${w.isFixed ? '[FIXED]' : ''} "${w.text}" w=${w.w}px overflow=${w.overflow}px sel=${w.sel}`
      : '';
    const fixedNote = (wf && wf !== w)
      ? ` | also-fixed: <${wf.tag}> w=${wf.w}px sel=${wf.sel}`
      : '';
    logFinding('🔴', projectName, route.name, 'horizontal-scroll',
      `scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} overflow=${overflow.scrollWidth - overflow.clientWidth}px${culprit}${fixedNote}`);
  }

  // 3. Tiny interactive elements (< 32x32)
  const tinyTargets = await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]');
    const tiny = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      // Skip invisible (size 0) and off-screen-below-fold elements
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width < 32 || rect.height < 32) {
        tiny.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
        });
      }
    }
    return tiny.slice(0, 5); // cap noise
  });
  for (const t of tinyTargets) {
    logFinding('🟡', projectName, route.name, 'tiny-tap-target',
      `${t.tag} "${t.text}" — ${t.w}×${t.h}px at (${t.x},${t.y})`);
  }

  // 4. Off-viewport interactive (anything with x < 0 or x > clientWidth)
  const offscreen = await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, [role="button"]');
    const w = document.documentElement.clientWidth;
    const off = [];
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.x < -1 || rect.x + rect.width > w + 1) {
        off.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 40),
          x: Math.round(rect.x),
          w: Math.round(rect.width),
        });
      }
    }
    return off.slice(0, 3);
  });
  for (const o of offscreen) {
    logFinding('🟠', projectName, route.name, 'offscreen-interactive',
      `${o.tag} "${o.text}" at x=${o.x} w=${o.w}px`);
  }

  // 4b. Font-size < 16px on phone viewports. iOS Safari zooms the page on
  // focus for any text input under 16px and never zooms back out — a known
  // mobile-usability trap independent of the WCAG tap-target checks above.
  // Tablet viewports (iPad) are excluded — the threshold is a phone-Safari
  // quirk, not a general a11y rule.
  const isPhoneViewport = !!viewport && viewport.width < 768;
  if (isPhoneViewport) {
    const tinyFonts = await page.evaluate(() => {
      const els = document.querySelectorAll('input, select, textarea');
      const tiny = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue; // not visible / collapsed
        const cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const fontSize = parseFloat(cs.fontSize);
        if (Number.isFinite(fontSize) && fontSize < 16) {
          tiny.push({
            tag: el.tagName,
            type: el.type || '',
            fontSize,
            hint: (el.placeholder || el.getAttribute('aria-label') || el.name || '').slice(0, 40),
          });
        }
      }
      return tiny.slice(0, 8);
    });
    for (const t of tinyFonts) {
      logFinding('🔴', projectName, route.name, 'small-font-zoom-risk',
        `${t.tag}${t.type ? `[${t.type}]` : ''} "${t.hint}" — ${t.fontSize}px (<16px triggers iOS auto-zoom-and-never-back)`);
    }
  }

  // 5. WCAG 2.1 A + AA accessibility scan via @axe-core/playwright.
  // Severity mapping: critical/serious -> 🔴, moderate -> 🟠, minor -> 🟡.
  // Cap to 8 violations per page so a deeply broken page can't drown out
  // the rest of the report. Skip on goto failures (already 🔴'd above).
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

// The single login happens in global-setup.js (runs once, before any worker)
// which writes .auth/cookies.json. We just read that file here — no logins
// happen inside the spec, so the worker-recycle-per-project behavior can't
// cause repeat logins / rate-limit trips. The file holds {cookies, error}.
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

test.describe.parallel('Mobile audit', () => {
  for (const route of PUBLIC_ROUTES) {
    test(`@public ${route.name}`, async ({ page }, testInfo) => {
      await auditPage(page, testInfo.project.use.viewport, route, testInfo.project.name);
    });
  }

  for (const route of AUTH_ROUTES) {
    test(`@auth ${route.name}`, async ({ page, context }, testInfo) => {
      test.skip(!hasCreds, 'TEST_USER_EMAIL + TEST_USER_PASSWORD not set');
      if (authError || !cachedAuthCookies) {
        logFinding('🔴', testInfo.project.name, route.name, 'auth-login-failed',
          `${authError || 'no cached cookies'} — check TEST_USER_EMAIL / TEST_USER_PASSWORD secrets`);
        return;
      }
      // Re-apply the single-login cookies to this test's fresh context.
      await context.addCookies(cachedAuthCookies);
      // Pre-accept the first-session Terms gate (client-side localStorage flag,
      // see TermsModal.js). Otherwise every fresh BrowserContext renders the
      // modal blocking the underlying page, and we end up auditing the modal
      // on every auth route instead of the actual app. addInitScript runs
      // before any page script in every frame on this context, so the flag
      // is set before TermsModal's mount-time check fires.
      await context.addInitScript(() => {
        try {
          localStorage.setItem('theopencrm.terms.accepted.v1', 'true');
          localStorage.setItem('theopencrm.terms.accepted_at.v1', new Date().toISOString());
        } catch { /* private mode, ignore */ }
      });
      // Mock the ambient auth/feature-probe endpoints. WHY: each test gets a
      // fresh BrowserContext that fires /auth/me + /auth/csrf + /ai/status on
      // mount. Across 5 viewports x 13 auth routes that's 200+ hits on auth-
      // limited endpoints — the backend's 30/15min/IP cap trips partway and
      // returns 429s. AuthContext then can't determine the user and the SPA
      // falls back to the unauth tree, redirecting every auth route to
      // Landing. The audit ends up measuring Landing's footer for half the
      // viewports — completely contaminated findings (52,000+px tall pages,
      // 'Schedule a consultation' on /companies, etc.). Mocking the three
      // probe endpoints keeps the SPA in its real authenticated rendering
      // regardless of rate-limit pressure. Mutating /api/* requests pass
      // through untouched so we still exercise real backend behaviour.
      await context.route('**/api/auth/me', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          user: {
            id: 7, email: 'crm-tester@theopencrm.com', name: 'Automation Tester',
            status: 'active', org_id: 1, org_role: 'admin', org_profile: 'generic',
            org_name: "johncolesassistant@gmail.com's Workspace",
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
  // MERGE this project's findings into the shared file rather than overwrite.
  // Playwright recycles the worker between projects (even at workers:1), so
  // `findings` only holds the current project's rows; a plain write would drop
  // the other four viewports. globalSetup zeroed the file at run start, and
  // workers:1 makes projects sequential, so read-concat-write is race-free.
  const outPath = path.join(__dirname, 'MOBILE_TEST_FINDINGS.json');
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (!Array.isArray(existing)) existing = [];
  } catch { existing = []; }
  fs.writeFileSync(outPath, JSON.stringify(existing.concat(findings), null, 2));
});
