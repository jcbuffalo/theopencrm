// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the super-admin AI Pay-as-you-go billing console (PR #15).
//
// We mock both `../api` (axios stand-in) and `../AuthContext` (so we can flip
// between super-admin and non-super-admin without going through /auth/me).
// `../components/Nav` is stubbed because it also calls api/auth and would
// otherwise add unrelated test surface.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth, mockApi } from '../test-utils';

// ----- Mocks -----

// `mockApi()` can't be referenced inside a hoisted block (the import isn't
// initialized when hoisting runs), so build the same shape inline here.
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

// The Nav bar isn't under test here — stub it to a marker element so renders
// stay focused on the page content.
vi.mock('../components/Nav', () => ({
  default: () => <nav data-testid="nav-stub" />,
}));

// Import AFTER mocks.
import AdminAiBilling from './AdminAiBilling';

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminAiBilling />
    </MemoryRouter>
  );
}

describe('AdminAiBilling', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset && fn.mockReset());
    api.get.mockResolvedValue({ data: { orgs: [], configured: true } });
    api.post.mockResolvedValue({ data: { ok: true } });
    currentAuth = defaultAuth;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows access denied for non-super-admin users', () => {
    currentAuth = {
      ...defaultAuth,
      user: { ...defaultAuth.user, role: 'member', is_super_admin: false },
    };
    renderPage();
    expect(screen.getByText(/Access denied/i)).toBeInTheDocument();
    expect(screen.getByText(/super-admin tool/i)).toBeInTheDocument();
    // Should NOT have fetched the list endpoint.
    expect(api.get).not.toHaveBeenCalled();
  });

  it('renders empty state when the orgs list comes back empty', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/No orgs to show/i)).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/billing/ai/admin/list');
  });

  it('renders one row per org with status, MTD usage, and threshold', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [
          { id: 1, name: 'Acme', status: 'active', mtd_usage_usd: 12.34, mtd_calls: 100, mtd_tokens: 250000, threshold_usd: 50, threshold_pct: 24 },
          { id: 2, name: 'Beta',  status: 'trial',  mtd_usage_usd: 0.05, mtd_calls: 4,   mtd_tokens: 1234,    threshold_usd: 50, threshold_pct: 0,  trial_ends_at: '2026-12-01T00:00:00Z' },
        ],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('$12.34')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Trial')).toBeInTheDocument();
    // Threshold cell carries the dollar/pct line.
    expect(screen.getByText(/\$50\.00\/mo · 24%/)).toBeInTheDocument();
  });

  it('surfaces the STRIPE_PRICE_AI_USAGE warning when configured is false', async () => {
    api.get.mockResolvedValueOnce({ data: { orgs: [], configured: false } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/STRIPE_PRICE_AI_USAGE not set/i)).toBeInTheDocument());
  });

  it('shows an error banner when the list endpoint fails', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce({ response: { data: { error: 'kaboom' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText('kaboom')).toBeInTheDocument());
  });

  it('filters out under-threshold rows when "Over threshold only" is toggled', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [
          { id: 1, name: 'UnderOrg', status: 'active', mtd_usage_usd: 5,   threshold_pct: 10  },
          { id: 2, name: 'OverOrg',  status: 'active', mtd_usage_usd: 200, threshold_pct: 410 },
        ],
      },
    });
    renderPage();
    await waitFor(() => expect(screen.getByText('UnderOrg')).toBeInTheDocument());
    expect(screen.getByText('OverOrg')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Over threshold only/i));
    expect(screen.queryByText('UnderOrg')).not.toBeInTheDocument();
    expect(screen.getByText('OverOrg')).toBeInTheDocument();
  });

  it('Comp button confirms then POSTs to /billing/ai/comp and reloads', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 17, name: 'Acme', status: 'active', mtd_usage_usd: 1, threshold_pct: 2 }],
      },
    });
    // After the post, load() refreshes. Stub that response too.
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 17, name: 'Acme', status: 'comped', mtd_usage_usd: 1, threshold_pct: 2 }],
      },
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Comp' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/billing/ai/comp', { org_id: 17 })
    );
    expect(confirmSpy).toHaveBeenCalled();
    // List re-fetched after the action — post resolves async, then load() runs.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    confirmSpy.mockRestore();
  });

  it('bails out of Comp when confirm() is cancelled', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 17, name: 'Acme', status: 'active', mtd_usage_usd: 1, threshold_pct: 2 }],
      },
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Comp' }));
    expect(api.post).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Trial prompts for days then POSTs /billing/ai/start-trial with the parsed days', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 9, name: 'Acme', status: 'past_due', mtd_usage_usd: 0, threshold_pct: 0 }],
      },
    });
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 9, name: 'Acme', status: 'trial', mtd_usage_usd: 0, threshold_pct: 0 }],
      },
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('30');
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Trial' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/billing/ai/start-trial', { org_id: 9, days: 30 })
    );
    promptSpy.mockRestore();
  });

  it('Trial bails when prompt is cancelled or returns a non-number', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [{ id: 9, name: 'Acme', status: 'past_due', mtd_usage_usd: 0, threshold_pct: 0 }],
      },
    });
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
    renderPage();
    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Trial' }));
    expect(api.post).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it('renders the platform budget card from the list payload and pauses new trials with one click', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        configured: true,
        orgs: [],
        platform_budget: {
          period: '2026-09', trials_enabled: true, accepting_trials: true, reason: null,
          active_trials: 4, trial_max_active: 25, trial_pct: 16, trial_org_hard_cap_usd: 25,
          mtd_trial_cost_usd: 12.5, mtd_unbilled_cost_usd: 90, mtd_all_cost_usd: 400, unbilled_budget_usd: 300, budget_pct: 30,
        },
      },
    });
    api.post.mockResolvedValueOnce({ data: { trials_enabled: false, accepting_trials: false, reason: 'paused', active_trials: 4, trial_max_active: 25, trial_pct: 16, trial_org_hard_cap_usd: 25, mtd_trial_cost_usd: 12.5, mtd_unbilled_cost_usd: 90, mtd_all_cost_usd: 400, unbilled_budget_usd: 300, budget_pct: 30, period: '2026-09' } });
    renderPage();
    const card = await screen.findByTestId('platform-budget-card');
    expect(card.textContent).toMatch(/\$90\.00/);
    expect(card.textContent).toMatch(/of \$300 budget \(30%\)/);
    expect(card.textContent).toMatch(/4/);
    expect(card.textContent).toMatch(/of 25 slots/);
    expect(card.textContent).toMatch(/Accepting/);
    fireEvent.click(screen.getByRole('button', { name: /pause new trials/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/billing/ai/admin/platform-budget/trials', { enabled: false }));
    await waitFor(() => expect(screen.getByTestId('platform-budget-card').textContent).toMatch(/Off \(paused\)/));
    expect(screen.getByRole('button', { name: /resume new trials/i })).toBeInTheDocument();
  });

  it('says the card is unavailable when the backend sends platform_budget: null', async () => {
    api.get.mockResolvedValueOnce({ data: { configured: true, orgs: [], platform_budget: null } });
    renderPage();
    const card = await screen.findByTestId('platform-budget-card');
    expect(card.textContent).toMatch(/Not available/);
  });
});
