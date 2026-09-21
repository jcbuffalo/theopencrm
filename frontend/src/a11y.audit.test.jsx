// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Accessibility audit (2026-09-21). Renders the pages a user or prospect hits
// first — the public front door, sign-in/up, and the daily-selling surfaces —
// through axe-core in jsdom and fails on any `moderate`, `serious` or `critical`
// violation. Color-contrast is excluded: jsdom does not lay out or paint, so
// axe cannot compute it here (a Lighthouse run in a real browser covers it).
//
// This is not a substitute for a manual screen-reader pass; it is the
// automated floor so a regression (a button with no name, a form control
// with no label, a duplicate id) cannot ship again.
//
// Run just this file with a full violation dump:
//   A11Y_VERBOSE=1 npx vitest run src/a11y.audit.test.jsx

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axe from 'axe-core';
import { defaultAuth } from './test-utils';

const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: [] })),
  post: vi.fn(() => Promise.resolve({ data: {} })),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('./api', () => ({
  default: api,
  api,
  auth: {
    login: vi.fn(() => Promise.resolve({ data: {} })),
    googleLogin: vi.fn(() => Promise.resolve({ data: {} })),
    me: vi.fn(() => Promise.resolve({ data: {} })),
    logout: vi.fn(() => Promise.resolve({ data: {} })),
  },
  POST_LOGIN_REDIRECT_KEY: 'ocrm_post_login_redirect',
  downloadBlob: vi.fn(),
  LIFECYCLE_STAGES: ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'],
  playbooks: { list: vi.fn(() => Promise.resolve([])) },
  cases: { list: vi.fn(() => Promise.resolve([])) },
  accounts: {
    list: vi.fn(() => Promise.resolve({ accounts: [], summary: { total: 0, gone_quiet: {}, renewing_soon: {} } })),
    get360: vi.fn(() => Promise.resolve({ header: {}, timeline: [] })),
    setLifecycleStage: vi.fn(() => Promise.resolve({})),
  },
  serviceContracts: {
    renewals: vi.fn(() => Promise.resolve({ stages: {}, total_count: 0, total_annual_value: 0, forecast_90d: { stages: {}, total_count: 0, total_annual_value: 0 } })),
    list: vi.fn(() => Promise.resolve([])),
  },
  segments: { list: vi.fn(() => Promise.resolve([])) },
  winback: { list: vi.fn(() => Promise.resolve([])) },
  pulse: { list: vi.fn(() => Promise.resolve([])) },
}));
vi.mock('./AuthContext', () => ({ useAuth: () => defaultAuth }));

import Landing from './pages/Landing';
import Login from './pages/Login';
import RequestAccess from './pages/RequestAccess';
import ForgotPassword from './pages/ForgotPassword';
import VerifyEmail from './pages/VerifyEmail';
import EmailAction from './pages/EmailAction';
import Chat from './pages/Chat';
import MyDay from './pages/MyDay';
import Setup from './pages/Setup';
import Templates from './pages/Templates';
import Deals from './pages/Deals';
import Leads from './pages/Leads';
import Contacts from './pages/Contacts';
import Companies from './pages/Companies';
import Accounts from './pages/Accounts';
import Tasks from './pages/Tasks';
import Activities from './pages/Activities';
import Calendar from './pages/Calendar';
import Notifications from './pages/Notifications';
import Dashboard from './pages/Dashboard';
import Reports from './pages/Reports';
import Forecast from './pages/Forecast';
import Sequences from './pages/Sequences';
import Renewals from './pages/Renewals';
import Cases from './pages/Cases';
import Settings from './pages/Settings';
import Team from './pages/Team';
import Usage from './pages/Usage';
import ImportWizard from './pages/ImportWizard';
import NotFound from './pages/NotFound';
import Compare from './pages/Compare';
import Vertical from './pages/Vertical';
import Nav from './components/Nav';

const PAGES = [
  // Public front door
  ['Landing', Landing],
  ['Login', Login],
  ['RequestAccess', RequestAccess],
  ['ForgotPassword', ForgotPassword],
  ['VerifyEmail', VerifyEmail],
  ['EmailAction', () => <EmailAction />],
  ['Compare/hubspot', () => <Compare slug="hubspot" />],
  ['Vertical/construction', () => <Vertical slug="construction" />],
  ['NotFound', NotFound],
  // App shell + daily selling
  ['Nav', () => <Nav />],
  ['Chat', Chat],
  ['MyDay', MyDay],
  ['Setup', Setup],
  ['Templates', Templates],
  ['Deals', Deals],
  ['Leads', Leads],
  ['Contacts', Contacts],
  ['Companies', Companies],
  ['Accounts', Accounts],
  ['Tasks', Tasks],
  ['Activities', Activities],
  ['Calendar', Calendar],
  ['Notifications', Notifications],
  ['Dashboard', Dashboard],
  ['Reports', Reports],
  ['Forecast', Forecast],
  ['Sequences', Sequences],
  ['Renewals', Renewals],
  ['Cases', Cases],
  ['ImportWizard', ImportWizard],
  // Workspace
  ['Settings', Settings],
  ['Team', Team],
  ['Usage', Usage],
];

// Endpoints whose consumers index into an object rather than a list. Anything
// else gets an empty list, which every list page tolerates.
const OBJECT_SHAPES = {
  '/my-day': { tasksDue: [], nextSteps: [], renewals: [], atRiskAccounts: [], quietAccounts: [], dealsNeedingAttention: [], meetings: [], summary: {} },
  '/dashboard': { widgets: [], layout: [] },
  '/dashboard/layout': { layout: [] },
  '/setup/templates': { templates: [] },
  '/workspace-templates': { templates: [] },
  '/public/workspace-templates': { templates: [] },
  '/notifications': { notifications: [], unread: 0 },
  '/usage': { month: {}, events: [] },
  '/ai/billing/status': { status: 'comped' },
  '/team': { members: [], invites: [] },
  '/org': { org: { id: 100, name: 'Test Workspace', profile: 'generic' }, members: [], pendingInvites: [] },
};
function mockGet(url) {
  const key = String(url || '').split('?')[0];
  for (const k of Object.keys(OBJECT_SHAPES)) {
    if (key === k || key.startsWith(`${k}/`)) return Promise.resolve({ data: OBJECT_SHAPES[k] });
  }
  return Promise.resolve({ data: [] });
}

const AXE_OPTIONS = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
  rules: {
    'color-contrast': { enabled: false }, // no layout/paint in jsdom
    region: { enabled: false }, // pages render without the app shell's landmarks here
  },
};

// moderate included: every heading-order finding from the first run was fixed,
// so the floor holds at that level too. minor (e.g. an empty <th>) still reports
// under A11Y_VERBOSE without failing.
const FAIL_ON = new Set(['critical', 'serious', 'moderate']);

function summarize(violations) {
  return violations.map((v) => {
    const nodes = v.nodes.slice(0, 3).map((n) => `      ${n.target.join(' ')}\n        ${n.html.slice(0, 160)}`).join('\n');
    return `  [${v.impact}] ${v.id}: ${v.help}\n${nodes}${v.nodes.length > 3 ? `\n      … +${v.nodes.length - 3} more` : ''}`;
  }).join('\n');
}

describe('accessibility floor (axe-core, jsdom)', () => {
  afterEach(() => cleanup());

  it.each(PAGES)('%s has no serious/critical axe violations', async (_name, Page) => {
    api.get.mockImplementation(mockGet);
    const { container } = render(
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled(), { timeout: 200 }).catch(() => {});
    const results = await axe.run(container, AXE_OPTIONS);
    const blocking = results.violations.filter((v) => FAIL_ON.has(v.impact));
    if (process.env.A11Y_VERBOSE && results.violations.length) {
      // eslint-disable-next-line no-console
      console.log(`\n${_name}:\n${summarize(results.violations)}`);
    }
    expect(blocking, `\n${_name} axe violations:\n${summarize(blocking)}\n`).toEqual([]);
  });
});
