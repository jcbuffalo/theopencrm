// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the self-service Modules page (/admin/feature-flags).
//
// An org OWNER who is NOT a platform admin can see their workspace's modules
// grouped in plain English and toggle them; a plain member is refused; the
// super-admin org selector only appears for super-admins.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth, memberAuth } from '../test-utils';

const api = vi.hoisted(() => ({
  get:    vi.fn(() => Promise.resolve({ data: {} })),
  post:   vi.fn(() => Promise.resolve({ data: {} })),
  patch:  vi.fn(() => Promise.resolve({ data: {} })),
  put:    vi.fn(() => Promise.resolve({ data: {} })),
  delete: vi.fn(() => Promise.resolve({ data: {} })),
}));
vi.mock('../api', () => ({
  default: api,
  auth: {},
  setCsrfToken: vi.fn(),
}));

let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({
  useAuth: () => currentAuth,
}));

vi.mock('../components/Nav', () => ({
  default: () => <nav data-testid="nav-stub" />,
}));

import AdminFeatureFlags from './AdminFeatureFlags';

// What GET /admin/feature-flags/flags returns to an org owner (no platform
// flags — the backend hides them for non-super-admins).
const OWNER_FLAGS = {
  orgId: 100,
  profile: 'generic',
  groups: ['Sell', 'Customers', 'Insights', 'Integrations', 'Platform'],
  flags: [
    { name: 'products_enabled', label: 'Products & quotes', oneLiner: 'A product catalog and a line-item quote builder.', description: 'engineer detail', group: 'Sell', scope: 'org', category: 'module', defaultValue: true, currentValue: true, isOverride: false },
    { name: 'quotes_enabled', label: 'Rep-agency customer quotes', oneLiner: 'Zang-style quotes.', description: 'engineer detail', group: 'Sell', scope: 'org', category: 'module', defaultValue: false, currentValue: false, isOverride: false },
    { name: 'plugins_enabled', label: 'Plugins', oneLiner: 'Build small sandboxed tools.', description: 'engineer detail', group: 'Insights', scope: 'org', category: 'tier', defaultValue: false, currentValue: false, isOverride: false },
  ],
};

// An org owner who is NOT in admin_users.
const ownerAuth = {
  ...defaultAuth,
  user: { ...defaultAuth.user, role: 'member', is_super_admin: false, org_role: 'owner', is_admin: false },
  isAdmin: false,
  adminRole: null,
  orgRole: 'owner',
  orgName: 'Northwind',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminFeatureFlags />
    </MemoryRouter>
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.delete.mockReset();
  api.get.mockResolvedValue({ data: { success: true, data: OWNER_FLAGS } });
  api.put.mockResolvedValue({ data: { success: true } });
  api.delete.mockResolvedValue({ data: { success: true } });
});

afterEach(() => {
  cleanup();
  currentAuth = defaultAuth;
});

describe('AdminFeatureFlags (Modules page)', () => {
  it('lets an org owner (not a platform admin) see grouped, plain-English modules', async () => {
    currentAuth = ownerAuth;
    renderPage();

    await screen.findByText('Products & quotes');
    expect(api.get).toHaveBeenCalledWith('/admin/feature-flags/flags');
    expect(screen.getByRole('heading', { name: 'Modules' })).toBeInTheDocument();
    expect(screen.getByText('Sell')).toBeInTheDocument();
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.getByText('A product catalog and a line-item quote builder.')).toBeInTheDocument();
    expect(screen.getByText('Northwind')).toBeInTheDocument();
    // "1 of 3 modules on"
    expect(screen.getByText('1')).toBeInTheDocument();
    // No super-admin org selector for an org owner.
    expect(screen.queryByText(/Super-admin: view org ID/)).not.toBeInTheDocument();
    // Engineer detail is behind a disclosure.
    expect(screen.queryByText(/engineer detail/)).not.toBeInTheDocument();
  });

  it('toggling a default-off module PUTs the org-scoped flag and reloads', async () => {
    currentAuth = ownerAuth;
    renderPage();
    await screen.findByText('Plugins');

    fireEvent.click(screen.getByRole('switch', { name: /Plugins: off/ }));

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/admin/feature-flags/flags/100/plugins_enabled', { value: true });
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('flipping an overridden module back to its default DELETEs the override', async () => {
    currentAuth = ownerAuth;
    api.get.mockResolvedValue({
      data: {
        success: true,
        data: {
          ...OWNER_FLAGS,
          flags: [{ ...OWNER_FLAGS.flags[2], currentValue: true, isOverride: true }],
        },
      },
    });
    renderPage();
    await screen.findByText('Plugins');
    expect(screen.getByText(/set for this workspace/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /Plugins: on/ }));

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('/admin/feature-flags/flags/100/plugins_enabled');
    });
    expect(api.put).not.toHaveBeenCalled();
  });

  it('refuses a plain member without calling the API', async () => {
    currentAuth = { ...memberAuth, orgRole: 'member' };
    renderPage();
    expect(await screen.findByText(/Only a workspace owner or admin/)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows the org selector for a platform super-admin', async () => {
    currentAuth = { ...defaultAuth, orgRole: 'member' };
    renderPage();
    await screen.findByText('Products & quotes');
    expect(screen.getByText(/Super-admin: view org ID/)).toBeInTheDocument();
  });
});
