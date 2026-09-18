// Self-contained UI + a11y review harness for the NOT-YET-DEPLOYED /segments
// page. Unlike the nightly walkers (which hit a live baseURL with a real
// login), this serves the LOCAL production build (vite preview) and stubs
// every API call with page.route — so we can drive the new page in real
// Chromium before it ships.
//
// Two independent perspectives, per the review brief:
//   1. Playwright (this file) — real-browser render, interaction, console
//      errors, horizontal-overflow check, and full-page screenshots at desktop
//      + mobile viewports.
//   2. axe-core (WCAG 2.1 A + AA) — objective accessibility grade, run against
//      the same live DOM.
//
// Findings are written to segments-ui-findings.json for the reviewer to grade.

const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, 'segments-ui-artifacts');
fs.mkdirSync(ART, { recursive: true });

const findings = [];
const record = (perspective, viewport, kind, detail) =>
  findings.push({ perspective, viewport, kind, detail });

// ---- API fixtures --------------------------------------------------------
const ME = {
  user: {
    id: 1, email: 'owner@example.com', name: 'Jordan Owner',
    is_admin: true, admin_role: null, org_role: 'owner',
    org_id: 100, org_name: 'Northwind Trading', org_profile: 'generic',
    org_branding: { displayName: 'Northwind Trading' }, org_tier: 'pro',
  },
};
const ORG_MEMBERS = {
  org: { id: 100, name: 'Northwind Trading', plan: 'pro', owner_user_id: 1 },
  members: [
    { id: 1, name: 'Jordan Owner', email: 'owner@example.com', org_role: 'owner' },
    { id: 2, name: 'Sam Rep', email: 'sam@example.com', org_role: 'member' },
    { id: 3, name: 'Riley CS', email: 'riley@example.com', org_role: 'admin' },
  ],
};
const SEG_LIST = [
  {
    id: 5, org_id: 100, name: 'At-risk manufacturers (60d quiet)',
    entity_type: 'company',
    criteria: [
      { field: 'lifecycle_stage', op: 'eq', value: 'at_risk' },
      { field: 'last_touch_older_than_days', op: 'gt', value: 60 },
    ],
    created_at: '2026-06-01T12:00:00Z',
  },
  {
    id: 6, org_id: 100, name: 'Champions to upsell',
    entity_type: 'contact',
    criteria: [{ field: 'title', op: 'ilike', value: 'director' }],
    created_at: '2026-06-10T12:00:00Z',
  },
];
const MEMBERS_5 = {
  total: 3, entity_type: 'company',
  members: [
    { id: 11, name: 'Acme Manufacturing', industry: 'Industrial', lifecycle_stage: 'at_risk', status: 'active', owner_id: 2 },
    { id: 12, name: 'Beta Tool & Die', industry: 'Manufacturing', lifecycle_stage: 'at_risk', status: 'active', owner_id: 2 },
    { id: 13, name: 'Gamma Fabrication', industry: 'Metals', lifecycle_stage: 'at_risk', status: 'active', owner_id: 3 },
  ],
};

async function stubApi(page) {
  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    // Credentialed (withCredentials) XHR: the browser rejects a wildcard ACAO,
    // so reflect the caller's Origin and allow credentials.
    const origin = req.headers()['origin'] || '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-csrf-token',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'vary': 'Origin',
    };
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json', headers: cors,
      body: JSON.stringify(body),
    });

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p === '/auth/me') return json(ME);
    if (p === '/ai/status') return json({ configured: true });
    if (p === '/auth/csrf') return json({ csrfToken: 'test-csrf' });
    if (p === '/org' && method === 'GET') return json(ORG_MEMBERS);
    if (p === '/segments' && method === 'GET') return json(SEG_LIST);
    if (p === '/segments/schema') return json({ entity_types: ['company', 'contact'] });
    if (p === '/segments/preview' && method === 'POST') {
      const body = req.postDataJSON() || {};
      const n = (body.criteria || []).length;
      return json({ count: n === 0 ? 128 : 17, sample: [] });
    }
    if (/^\/segments\/\d+\/members$/.test(p)) return json(MEMBERS_5);
    if (/^\/segments\/\d+\/bulk$/.test(p)) return json({ action: 'set_lifecycle_stage', affected: 3 });
    if (p === '/segments' && method === 'POST') return json({ ...SEG_LIST[0], id: 99 }, 201);
    // Anything else the SPA pokes at → empty 200 so boot never blocks.
    return json({});
  });
}

async function gotoSegments(page, viewport) {
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await stubApi(page);
  // Pre-dismiss the first-session Terms modal + cookie banner so their overlays
  // don't intercept clicks. We are reviewing the Segments surface, not onboarding.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('theopencrm.terms.accepted.v1', 'true');
      localStorage.setItem('theopencrm.terms.accepted_at.v1', new Date().toISOString());
      localStorage.setItem('cookieBannerDismissed', '2026-05-12');
    } catch (e) { /* ignore */ }
  });
  await page.goto('/segments', { waitUntil: 'networkidle' });
  // The page's own heading must be present (not a redirect to /login or a 404).
  await expect(page.getByRole('heading', { name: 'Segments', level: 1 })).toBeVisible({ timeout: 10000 });
  if (consoleErrors.length) record('playwright', viewport, 'console-error', consoleErrors.slice(0, 5));
  return consoleErrors;
}

async function checkNoHOverflow(page, viewport) {
  const overflow = await page.evaluate(() => {
    const de = document.documentElement;
    return { scrollW: de.scrollWidth, clientW: de.clientWidth };
  });
  if (overflow.scrollW > overflow.clientW + 1) {
    record('playwright', viewport, 'horizontal-overflow', overflow);
  }
}

async function axeScan(page, viewport, tag) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  const moderate = results.violations.filter((v) => ['moderate', 'minor'].includes(v.impact));
  if (results.violations.length) {
    record('axe-core', viewport, 'a11y-violations', results.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    })));
  }
  fs.writeFileSync(path.join(ART, `axe-${tag}.json`), JSON.stringify(results.violations, null, 2));
  return { serious: serious.length, moderate: moderate.length };
}

// ---- Desktop -------------------------------------------------------------
test.describe('Segments UI review — desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('empty-builder state + list, screenshot + axe', async ({ page }) => {
    await gotoSegments(page, 'desktop');
    await checkNoHOverflow(page, 'desktop');
    await page.screenshot({ path: path.join(ART, 'desktop-01-landing.png'), fullPage: true });
    const a = await axeScan(page, 'desktop', 'desktop-landing');
    record('axe-core', 'desktop', 'summary-landing', a);
  });

  test('selected segment → members + bulk bar + confirm dialog', async ({ page }) => {
    await gotoSegments(page, 'desktop');
    await page.getByText('At-risk manufacturers (60d quiet)').click();
    await expect(page.getByText('Acme Manufacturing')).toBeVisible();
    await page.screenshot({ path: path.join(ART, 'desktop-02-members.png'), fullPage: true });

    // Open the confirm-first dialog.
    await page.getByLabel('Bulk action').selectOption('set_lifecycle_stage');
    await page.getByLabel('New lifecycle stage').selectOption('active');
    await page.getByRole('button', { name: /^Run/ }).click();
    await expect(page.getByText('Confirm bulk action')).toBeVisible();
    await page.screenshot({ path: path.join(ART, 'desktop-03-confirm.png'), fullPage: true });
    await axeScan(page, 'desktop', 'desktop-confirm');
  });
});

// ---- Mobile --------------------------------------------------------------
test.describe('Segments UI review — mobile (iPhone SE 375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('mobile landing + members, screenshot + axe + overflow', async ({ page }) => {
    await gotoSegments(page, 'mobile');
    await checkNoHOverflow(page, 'mobile');
    await page.screenshot({ path: path.join(ART, 'mobile-01-landing.png'), fullPage: true });
    await page.getByText('At-risk manufacturers (60d quiet)').click();
    await expect(page.getByText('Acme Manufacturing')).toBeVisible();
    await checkNoHOverflow(page, 'mobile');
    await page.screenshot({ path: path.join(ART, 'mobile-02-members.png'), fullPage: true });
    const a = await axeScan(page, 'mobile', 'mobile');
    record('axe-core', 'mobile', 'summary', a);
  });
});

test.afterAll(async () => {
  fs.writeFileSync(path.join(__dirname, 'segments-ui-findings.json'), JSON.stringify(findings, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\n=== SEGMENTS UI FINDINGS (${findings.length}) ===\n` + JSON.stringify(findings, null, 2));
});
