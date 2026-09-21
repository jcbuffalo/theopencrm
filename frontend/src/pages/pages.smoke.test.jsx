// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Design-system smoke test (wave 2). Renders a sample of the migrated pages
// with a stubbed API + auth and asserts the two invariants every page now
// shares: exactly one <h1> (from PageHeader) and no emoji glyphs in the
// chrome. Emoji is allowed only in user content, and the mocked API returns
// no records, so any pictograph found here is chrome.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const emptyList = () => Promise.resolve({ data: [] });
const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: [] })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));

vi.mock('../api', () => ({
  default: api,
  api,
  POST_LOGIN_REDIRECT_KEY: 'ocrm_post_login_redirect',
  downloadBlob: vi.fn(),
  LIFECYCLE_STAGES: ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'],
  playbooks: {
    list: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
    remove: vi.fn(() => Promise.resolve({})),
  },
  cases: {
    list: vi.fn(() => Promise.resolve([])),
    get: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve({})),
    update: vi.fn(() => Promise.resolve({})),
  },
}));
vi.mock('../AuthContext', () => ({ useAuth: () => defaultAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Notifications from './Notifications';
import Activities from './Activities';
import Forecast from './Forecast';
import Products from './Products';
import Issues from './Issues';
import Appreciation from './Appreciation';
import Plugins from './Plugins';
import Surveys from './Surveys';
import Playbooks from './Playbooks';
import PitchReadiness from './PitchReadiness';
import Compare from './Compare';
import Vertical from './Vertical';
import CrmCostCalculator from '../components/CrmCostCalculator';
import { COMPARISONS } from '../marketing/comparisons';
import { VERTICALS } from '../marketing/verticals';

// Public marketing pages (spec 203, Phase 3) — same invariants, no auth, no
// API. Each comparison slug and each vertical slug renders through the same
// data-driven component, so one entry per data row catches a bad row.
const MARKETING_PAGES = [
  ...COMPARISONS.map((c) => [`Compare/${c.slug}`, () => <Compare slug={c.slug} />]),
  ...VERTICALS.map((v) => [`Vertical/${v.slug}`, () => <Vertical slug={v.slug} />]),
];

const PAGES = [
  ...MARKETING_PAGES,
  ['Notifications', Notifications],
  ['Activities', Activities],
  ['Forecast', Forecast],
  ['Products', Products],
  ['Issues', Issues],
  ['Appreciation', Appreciation],
  ['Plugins', Plugins],
  ['Surveys', Surveys],
  ['Playbooks', Playbooks],
  ['PitchReadiness', PitchReadiness],
];

// Extended_Pictographic covers the emoji blocks and the legacy dingbats
// (✅ ⚠️ 🚀 …) but not typographic marks like — … → ✓.
const EMOJI = /\p{Extended_Pictographic}/u;

describe('design-system smoke', () => {
  afterEach(() => cleanup());

  it.each(PAGES)('%s renders one h1 and no emoji in chrome', async (_name, Page) => {
    api.get.mockImplementation(emptyList);
    render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1));
    // Let any data-loading effects settle before scanning the DOM.
    await waitFor(() => expect(api.get).toHaveBeenCalled(), { timeout: 200 }).catch(() => {});
    expect(document.body.textContent).not.toMatch(EMOJI);
  });

  // The calculator is a section, not a page (no h1 of its own), so it gets
  // the emoji check plus the two things a visitor must be able to read.
  it('CrmCostCalculator renders both totals and no emoji', () => {
    render(
      <MemoryRouter>
        <CrmCostCalculator defaultCompetitor="hubspot" />
      </MemoryRouter>
    );
    expect(screen.getByTestId('calc-current-total').textContent).toMatch(/^\$[\d,]+$/);
    expect(screen.getByTestId('calc-open-total').textContent).toMatch(/^\$[\d,]+$/);
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(EMOJI);
  });

  it('marketing primary CTA stores the /setup intent and goes to signup', async () => {
    const { rememberSetupIntent, consumeSetupIntent, SETUP_INTENT_KEY } = await import('../marketing/cta');
    sessionStorage.clear();
    localStorage.clear();
    rememberSetupIntent();
    expect(sessionStorage.getItem('ocrm_post_login_redirect')).toBe('/setup');
    expect(localStorage.getItem(SETUP_INTENT_KEY)).toBe('/setup');
    expect(consumeSetupIntent()).toBe('/setup');
    expect(localStorage.getItem(SETUP_INTENT_KEY)).toBeNull();
    render(
      <MemoryRouter>
        <Compare slug="hubspot" />
      </MemoryRouter>
    );
    const ctas = screen.getAllByRole('button', { name: /build my crm/i });
    expect(ctas.length).toBeGreaterThan(0);
  });

  it('a template-carrying CTA intent round-trips, legacy "1" still means /setup, junk is ignored', async () => {
    const { rememberSetupIntent, consumeSetupIntent, SETUP_INTENT_KEY } = await import('../marketing/cta');
    sessionStorage.clear();
    localStorage.clear();
    rememberSetupIntent({ templateId: 42 });
    expect(sessionStorage.getItem('ocrm_post_login_redirect')).toBe('/setup?template=wt:42');
    expect(consumeSetupIntent()).toBe('/setup?template=wt:42');
    localStorage.setItem(SETUP_INTENT_KEY, '1');
    expect(consumeSetupIntent()).toBe('/setup');
    localStorage.setItem(SETUP_INTENT_KEY, 'https://evil.example/phish');
    expect(consumeSetupIntent()).toBeNull();
    localStorage.setItem(SETUP_INTENT_KEY, '/setup?template=wt:1;x');
    expect(consumeSetupIntent()).toBeNull();
    expect(localStorage.getItem(SETUP_INTENT_KEY)).toBeNull();
  });

  it('a vertical page shows the live starter template from the public gallery and its CTA carries the id', async () => {
    const { _resetPublicTemplatesCache } = await import('../marketing/usePlatformTemplate');
    _resetPublicTemplatesCache();
    sessionStorage.clear();
    localStorage.clear();
    api.get.mockImplementation((url) => {
      if (url === '/public/workspace-templates') {
        return Promise.resolve({ data: { templates: [
          { id: 7, slug: 'construction', name: 'Construction contractor', tagline: 'Bids to awards.', is_platform: true,
            stages: ['Bid invite', 'Site visit', 'Submitted', 'Awarded'], pipeline_name: 'Bids',
            field_labels: ['Bid due', 'GC'], automation_count: 1, view_count: 2, use_count: 3 },
          { id: 8, slug: 'saas', name: 'SaaS', is_platform: true, stages: [] },
        ] } });
      }
      return Promise.resolve({ data: {} });
    });
    render(
      <MemoryRouter>
        <Vertical slug="construction" />
      </MemoryRouter>
    );
    const card = await screen.findByTestId('live-template');
    expect(card.textContent).toMatch(/Construction contractor/);
    expect(card.textContent).toMatch(/Bids pipeline/);
    expect(card.textContent).toMatch(/Bid invite/);
    expect(card.textContent).toMatch(/2 custom fields/);
    expect(card.textContent).toMatch(/1 follow-up ruleEach/);
    expect(card.textContent).toMatch(/Used by 3 workspaces/);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /start with this template/i }));
    expect(sessionStorage.getItem('ocrm_post_login_redirect')).toBe('/setup?template=wt:7');
    expect(document.body.textContent).not.toMatch(EMOJI);
    api.get.mockImplementation(() => Promise.resolve({ data: [] }));
    _resetPublicTemplatesCache();
  });

  it('a vertical page without a live template renders the static copy only', async () => {
    const { _resetPublicTemplatesCache } = await import('../marketing/usePlatformTemplate');
    _resetPublicTemplatesCache();
    api.get.mockImplementation(() => Promise.reject(new Error('offline')));
    render(
      <MemoryRouter>
        <Vertical slug="construction" />
      </MemoryRouter>
    );
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/public/workspace-templates'));
    expect(screen.queryByTestId('live-template')).toBeNull();
    expect(screen.getAllByRole('button', { name: /build my crm/i }).length).toBeGreaterThan(0);
    api.get.mockImplementation(() => Promise.resolve({ data: [] }));
    _resetPublicTemplatesCache();
  });
});
