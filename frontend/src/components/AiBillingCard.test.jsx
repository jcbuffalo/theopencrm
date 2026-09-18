// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// AiBillingCard — the self-serve "Start AI pay-as-you-go" front door.
//
// Contract under test: for every billing verdict the backend can return,
// the user sees a next step in plain English (a button they can press, or
// who to ask), never a raw error code and never a dead button.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const post = vi.fn();
vi.mock('../api', () => ({ default: { post: (...a) => post(...a), get: vi.fn() } }));

import AiBillingCard from './AiBillingCard';

function renderCard(props) {
  return render(
    <MemoryRouter>
      <AiBillingCard {...props} />
    </MemoryRouter>
  );
}

const unbilled = {
  allowed: false,
  status: 'unconfigured',
  code: 'AI_BILLING_REQUIRED',
  action: 'start_billing',
  message: 'AI usage requires an active billing subscription.',
  can_manage: true,
  stripe_ready: true,
};

beforeEach(() => {
  cleanup();
  post.mockReset();
});

describe('start_billing', () => {
  it('owner sees a Start button that opens checkout returning to chat', async () => {
    // Resolve without a url so the component reports instead of navigating
    // (jsdom can't follow window.location assignments).
    post.mockResolvedValue({ data: {} });
    renderCard({ billing: unbilled, returnTo: 'chat' });
    expect(screen.getByText('Turn on AI for your workspace')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /start ai pay-as-you-go/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/billing/ai/start', { return_to: 'chat' }));
    await screen.findByText(/no checkout url/i);
  });

  it('explains in plain English when Stripe is not wired on this deployment', async () => {
    post.mockRejectedValue({ response: { data: { code: 'STRIPE_NOT_CONFIGURED' } } });
    renderCard({ billing: unbilled });
    fireEvent.click(screen.getByRole('button', { name: /start ai pay-as-you-go/i }));
    await screen.findByText(/isn't switched on for this deployment yet/i);
    expect(screen.queryByText(/STRIPE_NOT_CONFIGURED/)).toBeNull();
  });

  it('non-admin gets told who can turn it on, with no dead button', () => {
    renderCard({ billing: { ...unbilled, can_manage: false } });
    expect(screen.queryByRole('button', { name: /start ai/i })).toBeNull();
    expect(screen.getByText(/ask your workspace owner or admin/i)).toBeInTheDocument();
  });

  it('expired trial gets its own headline', () => {
    renderCard({ billing: { ...unbilled, code: 'AI_BILLING_TRIAL_EXPIRED', status: 'trial' } });
    expect(screen.getByText('Your AI trial has ended')).toBeInTheDocument();
  });
});

describe('other verdicts', () => {
  it('update_payment opens the Stripe portal', async () => {
    post.mockResolvedValue({ data: {} });
    renderCard({ billing: { ...unbilled, code: 'AI_BILLING_PAST_DUE', action: 'update_payment', status: 'past_due' } });
    fireEvent.click(screen.getByRole('button', { name: /update payment method/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/billing/portal'));
  });

  it('contact_admin shows the halt reason and (for owners) a link to Usage', () => {
    renderCard({ billing: { ...unbilled, code: 'AI_BILLING_HALTED', action: 'contact_admin', status: 'halted', message: 'AI usage is halted by your organization admin.' } });
    expect(screen.getByText('AI is paused for this workspace')).toBeInTheDocument();
    expect(screen.getByText(/halted by your organization admin/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /usage/i })).toHaveAttribute('href', '/usage');
  });

  it('trial variant renders a countdown strip', () => {
    const ends = new Date(Date.now() + 3 * 86400000 + 60000).toISOString();
    renderCard({ billing: { allowed: true, status: 'trial', trial_ends_at: ends, can_manage: true, stripe_ready: true }, variant: 'trial' });
    expect(screen.getByText(/4 days left|3 days left/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up billing now/i })).toBeInTheDocument();
  });

  it('renders nothing without a verdict', () => {
    const { container } = renderCard({ billing: null });
    expect(container.firstChild).toBeNull();
  });
});
