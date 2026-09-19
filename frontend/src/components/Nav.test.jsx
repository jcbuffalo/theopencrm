// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the grouped top bar (components/Nav.js + components/nav/*).
//
// jsdom applies no CSS, so the desktop bar and (when open) the mobile sheet
// both exist in the DOM; queries are scoped with `within` where that matters.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { defaultAuth, memberAuth, zangAuth } from '../test-utils';
import { buildNavModel, resolveActive, buildDestinations, matchDestinations } from './nav/navConfig';
import { getStageConfig } from '../stages';

const api = vi.hoisted(() => ({
  get:    vi.fn(() => Promise.resolve({ data: {} })),
  post:   vi.fn(() => Promise.resolve({ data: {} })),
  patch:  vi.fn(() => Promise.resolve({ data: {} })),
  put:    vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({ default: api, auth: {}, setCsrfToken: vi.fn() }));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));

import Nav from './Nav';

const ALL_ON = null; // missing map = older backend = everything on

function renderNav(active) {
  return render(
    <MemoryRouter>
      <Nav active={active} />
    </MemoryRouter>
  );
}

const desktop = () => screen.getByRole('navigation', { name: 'Main' });
const openGroup = (name) => {
  const btn = within(desktop()).getByRole('button', { name: `${name} menu` });
  fireEvent.click(btn);
  return btn;
};

describe('Nav — grouped top bar', () => {
  beforeEach(() => {
    api.get.mockResolvedValue({ data: {} });
    currentAuth = { ...defaultAuth, orgFeatures: ALL_ON };
  });
  afterEach(() => cleanup());

  it('renders the six primary entries for a generic org and no flat link soup', () => {
    renderNav('chat');
    const bar = desktop();
    expect(within(bar).getByRole('link', { name: /chat/i })).toHaveAttribute('href', '/chat');
    expect(within(bar).getByRole('link', { name: 'My Day' })).toHaveAttribute('href', '/today');
    ['Pipeline', 'People', 'Customers', 'Reports'].forEach((g) => {
      expect(within(bar).getByRole('button', { name: `${g} menu` })).toHaveAttribute('aria-haspopup', 'menu');
    });
    // Zang-only Ops group is absent for generic; leaf pages are not top-level.
    expect(within(bar).queryByRole('button', { name: 'Ops menu' })).toBeNull();
    expect(within(bar).queryByRole('link', { name: 'Renewals' })).toBeNull();
    // Compliance strip is gone from the nav.
    expect(screen.queryByText(/provided AS IS/i)).toBeNull();
  });

  it('hides the empty Customers group (and lifecycle/retention reports) until the org has a customer or won deal', () => {
    // Day one: /auth/me says org_has_customers=false.
    currentAuth = { ...defaultAuth, orgFeatures: ALL_ON, orgHasCustomers: false };
    renderNav('deals');
    let bar = desktop();
    expect(within(bar).queryByRole('button', { name: 'Customers menu' })).toBeNull();
    // Accounts stays under People — that's where the first account is made.
    openGroup('People');
    expect(screen.getByRole('menuitem', { name: 'Accounts' })).toBeInTheDocument();
    cleanup();

    // First customer / won deal → the group is back.
    currentAuth = { ...defaultAuth, orgFeatures: ALL_ON, orgHasCustomers: true };
    renderNav('deals');
    bar = desktop();
    expect(within(bar).getByRole('button', { name: 'Customers menu' })).toBeInTheDocument();
    cleanup();

    // Unknown (older backend, null) keeps everything visible.
    currentAuth = { ...defaultAuth, orgFeatures: ALL_ON, orgHasCustomers: null };
    renderNav('deals');
    expect(within(desktop()).getByRole('button', { name: 'Customers menu' })).toBeInTheDocument();

    // The palette's destinations are NOT pruned — every page stays a keystroke away.
    const dests = buildDestinations({ cfg: getStageConfig('generic'), orgFeatures: ALL_ON, isAdmin: false, isSuperAdmin: false });
    expect(dests.some((d) => d.key === 'renewals')).toBe(true);
  });

  it('hides items whose feature flag is off', () => {
    currentAuth = {
      ...defaultAuth,
      orgFeatures: { leads_enabled: false, products_enabled: false, campaigns_enabled: false, plugins_enabled: false },
    };
    renderNav('deals');
    openGroup('Pipeline');
    const menu = screen.getByRole('menu', { name: 'Pipeline menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Deals' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Leads' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Products' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Email sequences' })).toBeNull();
    // Generic Quotes item rides on products_enabled (sales-quotes API gate).
    expect(within(menu).queryByRole('menuitem', { name: 'Quotes' })).toBeNull();
  });

  it('drops the whole Customers group when customer_success_enabled is off', () => {
    currentAuth = { ...defaultAuth, orgFeatures: { customer_success_enabled: false } };
    renderNav('deals');
    expect(within(desktop()).queryByRole('button', { name: 'Customers menu' })).toBeNull();
  });

  it('lights the group when a child page key is active (existing keys keep working)', () => {
    renderNav('forecast');
    const pipeline = within(desktop()).getByRole('button', { name: 'Pipeline menu' });
    expect(pipeline).toHaveAttribute('data-active', 'true');
    expect(within(desktop()).getByRole('button', { name: 'People menu' })).not.toHaveAttribute('data-active');
    fireEvent.click(pipeline);
    expect(screen.getByRole('menuitem', { name: 'Forecast' })).toHaveAttribute('aria-current', 'page');
  });

  it('maps alias keys (winback → Reports group, Retention & Win-back item)', () => {
    renderNav('winback');
    const reports = within(desktop()).getByRole('button', { name: 'Reports menu' });
    expect(reports).toHaveAttribute('data-active', 'true');
    fireEvent.click(reports);
    expect(screen.getByRole('menuitem', { name: 'Retention & Win-back' })).toHaveAttribute('aria-current', 'page');
  });

  it('puts Admin in the account menu for admins, pointing at the /admin hub', () => {
    renderNav('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const menu = screen.getByRole('menu', { name: 'Account menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Admin' })).toHaveAttribute('href', '/admin');
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('omits Admin from the account menu for non-admins', () => {
    currentAuth = { ...memberAuth, orgFeatures: ALL_ON };
    renderNav('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(within(screen.getByRole('menu', { name: 'Account menu' })).queryByRole('menuitem', { name: 'Admin' })).toBeNull();
  });

  it('closes a dropdown on Escape and on click-outside', () => {
    renderNav('deals');
    const btn = openGroup('Pipeline');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Pipeline menu' }), { key: 'Escape' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    fireEvent.mouseDown(document.body);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('adds the Ops group and points Quotes at /quotes for advanced-panel profiles', () => {
    currentAuth = { ...zangAuth, orgFeatures: ALL_ON };
    renderNav('issues');
    const ops = within(desktop()).getByRole('button', { name: 'Ops menu' });
    expect(ops).toHaveAttribute('data-active', 'true');
    fireEvent.click(ops);
    const menu = screen.getByRole('menu', { name: 'Ops menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Issues' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Appreciation' })).toBeInTheDocument();
    expect(within(menu).queryByText('🎁')).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    openGroup('Pipeline');
    expect(screen.getByRole('menuitem', { name: 'Quotes' })).toHaveAttribute('href', '/quotes');
  });

  it('renders the mobile sheet with group headings, search on top and account items at the bottom', () => {
    renderNav('contacts');
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const sheet = screen.getByTestId('mobile-sheet');
    expect(within(sheet).getByRole('button', { name: /search or ask/i })).toBeInTheDocument();
    [['pipeline', 'Pipeline'], ['people', 'People'], ['customers', 'Customers'], ['reports', 'Reports'], ['account', 'Account']].forEach(([id, label]) => {
      const heading = sheet.querySelector(`#sheet-${id}`);
      expect(heading, id).not.toBeNull();
      expect(heading.textContent).toBe(label);
    });
    expect(within(sheet).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(within(sheet).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // Escape closes the sheet.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('mobile-sheet')).toBeNull();
  });
});

describe('navConfig helpers', () => {
  const cfg = getStageConfig('generic');

  it('resolveActive maps every page key the app passes to a group', () => {
    const model = buildNavModel({ cfg, orgFeatures: null, isAdmin: true });
    const expectations = {
      chat: 'chat', today: 'today', deals: 'pipeline', leads: 'pipeline', tasks: 'pipeline', 'quote-builder': 'pipeline',
      forecast: 'pipeline', products: 'pipeline', sequences: 'pipeline',
      contacts: 'people', companies: 'people', accounts: 'people', import: 'people',
      renewals: 'customers', 'service-contracts': 'customers', cases: 'customers', playbooks: 'customers', surveys: 'customers', segments: 'customers',
      dashboard: 'reports', reports: 'reports', 'lifecycle-funnel': 'reports', retention: 'reports', winback: 'reports',
      settings: 'account', team: 'account', usage: 'account', plugins: 'account', calendar: 'account', activities: 'account',
      notifications: 'account', admin: 'account', 'email-templates': 'account',
    };
    for (const [key, group] of Object.entries(expectations)) {
      expect(resolveActive(model, key).groupKey, key).toBe(group);
    }
  });

  it('a group with one surviving item collapses into a plain link', () => {
    const model = buildNavModel({
      cfg,
      orgFeatures: { reports_enabled: false, customer_success_enabled: false },
      isAdmin: false,
    });
    const dash = model.primary.find((e) => e.key === 'dashboard');
    expect(dash).toBeTruthy();
    expect(dash.type).toBe('link');
    expect(dash.to).toBe('/dashboard');
    expect(resolveActive(model, 'dashboard').groupKey).toBe('reports');
  });

  it('buildDestinations exposes demoted pages and admin pages by name', () => {
    const dest = buildDestinations({ cfg, orgFeatures: null, isAdmin: true, isSuperAdmin: false });
    const labels = matchDestinations(dest, 'feature flags').map((d) => d.label);
    expect(labels[0]).toBe('Feature flags');
    expect(matchDestinations(dest, 'renewals')[0].to).toBe('/renewals');
    expect(matchDestinations(dest, 'usage')[0].to).toBe('/usage');
    expect(matchDestinations(dest, 'import')[0].to).toBe('/import');
    expect(matchDestinations(dest, 'branding')[0].to).toBe('/admin/branding');
    // Super-admin pages are hidden from org admins.
    expect(matchDestinations(dest, 'provision')).toHaveLength(0);
    const superDest = buildDestinations({ cfg, orgFeatures: null, isAdmin: true, isSuperAdmin: true });
    expect(matchDestinations(superDest, 'provision')[0].to).toBe('/admin/provision-org');
  });
});
