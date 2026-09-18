// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the WelcomeCard component.
//
// Focus: the first-run UX contract — show once, dismiss persists, per-task
// completion persists, profile-appropriate task list, brand-aware greeting
// precedence, and (since the Chat-first refinement) tasks are chat PROMPTS
// that seed the composer via onPrompt rather than links that leave the page.
// The card auto-hides once the org has data (hasData=true).
//
// We mock AuthContext rather than the real provider so each test can dial
// in user / org_id / org_profile / org_branding without an /auth/me call.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth } from '../test-utils';

// Mock AuthContext so useAuth() returns whatever we set authState to. The
// mock factory closes over an outer `currentAuth` reference; each test mutates
// it before rendering. This keeps the mock module-level (vi.mock is hoisted)
// while letting individual tests swap the auth value.
let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({
  useAuth: () => currentAuth,
}));

import WelcomeCard from './WelcomeCard';

function renderCard(props = {}) {
  return render(
    <MemoryRouter>
      <WelcomeCard {...props} />
    </MemoryRouter>
  );
}

describe('WelcomeCard', () => {
  beforeEach(() => {
    localStorage.clear();
    currentAuth = { ...defaultAuth };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the generic task list for a generic-profile org', () => {
    currentAuth = { ...defaultAuth, orgProfile: 'generic' };
    renderCard();
    expect(screen.getByText(/Import your contacts/i)).toBeInTheDocument();
    expect(screen.getByText(/Add your first deal/i)).toBeInTheDocument();
    expect(screen.getByText(/Ask what I can do/i)).toBeInTheDocument();
    // A zang-only task should not appear.
    expect(screen.queryByText(/Review your active RFQs/i)).not.toBeInTheDocument();
  });

  it('renders the zang task list when org_profile is zang', () => {
    currentAuth = { ...defaultAuth, orgProfile: 'zang' };
    renderCard();
    expect(screen.getByText(/Review your active RFQs/i)).toBeInTheDocument();
    expect(screen.getByText(/Add a vendor quote/i)).toBeInTheDocument();
    expect(screen.getByText(/Open Issues board/i)).toBeInTheDocument();
    // Generic-only label should not be present.
    expect(screen.queryByText(/Import your contacts/i)).not.toBeInTheDocument();
  });

  it('falls back to the generic list for unknown profiles (jcp)', () => {
    currentAuth = { ...defaultAuth, orgProfile: 'jcp' };
    renderCard();
    expect(screen.getByText(/Import your contacts/i)).toBeInTheDocument();
  });

  it('greets by orgBranding.displayName when present', () => {
    currentAuth = {
      ...defaultAuth,
      orgName: 'Raw Org Name',
      orgBranding: { displayName: 'Northwind Pro' },
    };
    renderCard();
    expect(screen.getByText(/Welcome to The Open CRM, Northwind Pro\./)).toBeInTheDocument();
  });

  it('falls back to orgName when branding is absent', () => {
    currentAuth = {
      ...defaultAuth,
      orgName: 'Acme Sales Co',
      orgBranding: {},
    };
    renderCard();
    expect(screen.getByText(/Welcome to The Open CRM, Acme Sales Co\./)).toBeInTheDocument();
  });

  it('falls back to the user first name when branding and orgName are absent', () => {
    currentAuth = {
      ...defaultAuth,
      orgName: null,
      orgBranding: null,
      user: { ...defaultAuth.user, name: 'Dana Lee' },
    };
    renderCard();
    expect(screen.getByText(/Welcome to The Open CRM, Dana\./)).toBeInTheDocument();
  });

  it('persists dismissal in localStorage, calls onDismiss, and returns null on re-render', () => {
    currentAuth = {
      ...defaultAuth,
      user: { ...defaultAuth.user, id: 7, org_id: 42 },
    };
    const onDismiss = vi.fn();
    const { unmount } = renderCard({ onDismiss });

    const dismissBtn = screen.getByLabelText(/Dismiss welcome card/i);
    fireEvent.click(dismissBtn);

    // After dismiss the card unrenders and the host is told.
    expect(screen.queryByText(/Welcome to The Open CRM/i)).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // localStorage carries the dismissedAt timestamp under the per-user key.
    const raw = localStorage.getItem('theopencrm.welcome.v1.7.42');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw).dismissedAt).toBeTruthy();

    // Re-mount with the same storage state — card should not render.
    unmount();
    renderCard();
    expect(screen.queryByText(/Welcome to The Open CRM/i)).not.toBeInTheDocument();
  });

  it('persists per-task completion clicks', () => {
    currentAuth = {
      ...defaultAuth,
      user: { ...defaultAuth.user, id: 7, org_id: 42 },
    };
    renderCard();

    const importLink = screen.getByText(/Import your contacts/i);
    fireEvent.click(importLink);

    const raw = localStorage.getItem('theopencrm.welcome.v1.7.42');
    const parsed = JSON.parse(raw);
    expect(parsed.completed.import_contacts).toBeTruthy();
    // Other tasks untouched.
    expect(parsed.completed.invite_teammate).toBeFalsy();
  });

  it('prompt tasks seed the composer via onPrompt instead of navigating', () => {
    const onPrompt = vi.fn();
    renderCard({ onPrompt });
    const task = screen.getByText(/Add your first deal/i);
    expect(task.closest('a')).toBeNull();
    fireEvent.click(task);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt.mock.calls[0][0]).toMatch(/first deal/i);
    // CSV import genuinely needs another screen — it stays a link.
    expect(screen.getByText(/Import your contacts/i).closest('a')).toHaveAttribute('href', '/import');
  });

  it('only offers "Load sample data" when the host provides onSeedDemo', () => {
    renderCard();
    expect(screen.queryByText(/Load sample data/i)).not.toBeInTheDocument();
    cleanup();
    const onSeedDemo = vi.fn();
    renderCard({ onSeedDemo });
    fireEvent.click(screen.getByText(/Load sample data/i));
    expect(onSeedDemo).toHaveBeenCalledTimes(1);
  });

  it('renders nothing once the org has data', () => {
    const { container } = renderCard({ hasData: true });
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing while user has not loaded yet', () => {
    currentAuth = { ...defaultAuth, user: null };
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });
});
