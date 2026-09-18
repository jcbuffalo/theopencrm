# UI/UX Polish Pass — Audit Plan

Static plan for the Lighthouse + axe-core audit that would normally precede
this polish pass. The fix-pass landed manually (see PR body for the bucketed
issue list); this file records what *would have been* automated so a later
session can re-run the tooling once the worktree has network access.

## Why this is static

The polish pass ran in a sandboxed worktree with no outbound network access
(verified — `curl https://app.theopencrm.com` is denied). That blocks:

- `lighthouse` CLI runs against `https://app.theopencrm.com/*`
- `@axe-core/playwright` runs (axe-core ships its rule engine in-process,
  but the Playwright suite still needs to navigate to the live URL)
- npm installs to add `playwright-lighthouse` or update test deps

Rather than fake numbers, this file documents the intended runbook. When
re-running, drop the resulting JSON reports next to this file under the
naming conventions below.

## URLs in scope

| URL                       | Auth?        | Why it's in the audit                 |
|---------------------------|--------------|---------------------------------------|
| `/`                       | public       | Landing — primary acquisition surface |
| `/login`                  | public       | First impression for returning users  |
| `/`                       | authed       | Chat-First front door                 |
| `/deals`                  | authed       | Highest-traffic CRUD surface          |
| `/chat`                   | authed       | Conversational copilot                |
| `/admin/ai-billing`       | super-admin  | Densest table, busiest action bar     |

Auth credentials come from `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` (see
`tests/global-setup.js`). If unset, skip authed routes and note it in the PR
body — partial coverage is better than no coverage.

## Tooling commands (when network is available)

```bash
# 1. Lighthouse — one report per URL, JSON output
cd tests
npx playwright install chromium

# Public routes — no auth needed
npx lighthouse https://app.theopencrm.com/        --output json --output-path ui-audit/lh-landing.json       --only-categories=performance,accessibility,best-practices,seo --quiet
npx lighthouse https://app.theopencrm.com/login   --output json --output-path ui-audit/lh-login.json         --only-categories=performance,accessibility,best-practices,seo --quiet

# Authed routes — use a Playwright session, then point Lighthouse at the
# resulting chrome instance via --port. See playwright-lighthouse docs.

# 2. axe-core — already wired into tests/mobile.spec.js via @axe-core/playwright.
# The walker writes findings to playwright-artifacts/findings.json.
TEST_USER_EMAIL=… TEST_USER_PASSWORD=… npx playwright test
```

## Expected JSON file naming

If/when the tooling runs, drop reports here:

```
tests/ui-audit/
├── PLAN.md                            ← this file
├── lh-landing.json                    ← Lighthouse JSON for /
├── lh-login.json                      ← Lighthouse JSON for /login
├── lh-chat.json                       ← (authed) Lighthouse JSON for /chat
├── lh-deals.json                      ← (authed) Lighthouse JSON for /deals
├── lh-ai-billing.json                 ← (super-admin) Lighthouse JSON for /admin/ai-billing
├── axe-findings.json                  ← axe-core violation count + top-10
└── screenshots/
    ├── before-deals.png
    ├── after-deals.png
    ├── before-login.png
    ├── after-login.png
    ├── before-admin-ai-billing.png
    └── after-admin-ai-billing.png
```

## Manual audit (done in this pass — see PR body)

Even with tooling unavailable, every page in scope was audited against the
checklist in the parent task brief:

- **Typography**: one body font (system-ui stack), Tailwind heading scale,
  body ≥14px on tables, no <400 weights — pass.
- **Color contrast**: ground truth is `tailwind.config.cjs` palette comments;
  `brand-mint-dark` already hardened to `#1F6B3D` (~5.7:1) in a prior pass.
  This pass tightens the few amber-on-white and gray-on-gray drifts found
  during the read-through.
- **Spacing**: Tailwind scale is consistent; the changes here only normalise
  the few hand-rolled paddings on the rebuilt primitives.
- **CTAs**: standardised via the new `Button` primitive — `primary` is filled
  brand-blue, `secondary` outline, `ghost` text, `danger` red. Migrated the
  ~12 highest-traffic call sites; the rest stay on bespoke styles for a
  follow-up sweep.
- **Empty + loading + error states**: Tasks/Activities already friendly;
  this pass adds EmptyState component + uses it for Companies, Contacts,
  Deals (Focus mode), DataTable's table-wide empty.
- **Mobile**: Nav hamburger at `xl:` breakpoint already verified by a prior
  audit pass; no regression here. The new Button enforces `min-h-[44px]`
  on the `md` and `lg` sizes so any migration tightens the floor.

## What's deferred to a follow-up

- Lighthouse + axe-core automated runs against production (network-blocked
  in this worktree)
- Headless UI Dialog migration for the bespoke `AddModal` in `Deals.js` —
  AddModal works but should adopt `@headlessui/react` Dialog for focus-trap
  semantics; deferred because it's the most-touched modal and the diff
  benefit is small relative to risk. Listed in the PR body's P2 deferral.
- Sweep of the remaining ~180 button usages that didn't get touched in
  this pass.
