// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// /templates gallery (spec 203 Phase 2): grouping (yours / starters /
// community), owner-only save + manage, "Use" hands off to /setup?template=wt:<id>,
// super-admin generate button, and the Setup ?template= parser.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { defaultAuth } from '../test-utils';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('../api', () => ({ default: api }));
let currentAuth = defaultAuth;
vi.mock('../AuthContext', () => ({ useAuth: () => currentAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Templates from './Templates';
import { parseTemplateParam } from './Setup';

const ROWS = [
  { id: 1, org_id: 100, is_platform: false, is_public: false, name: 'Our process', tagline: null, stages: ['A', 'B', 'Won', 'Lost'], field_labels: ['X'], automation_count: 0, view_count: 0, use_count: 0 },
  { id: 2, org_id: null, is_platform: true, is_public: true, name: 'SaaS starter', tagline: 'Trials to renewals', stages: ['Trial', 'Demo', 'Won', 'Lost'], field_labels: ['Seats', 'Plan'], automation_count: 2, view_count: 1, use_count: 12 },
  { id: 3, org_id: 555, is_platform: false, is_public: true, name: 'Roofing crew', tagline: 'Bids to jobs', stages: ['Bid', 'Awarded', 'Lost'], field_labels: [], automation_count: 1, view_count: 0, use_count: 2 },
];

function renderPage(initial = '/templates') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/templates" element={<Templates />} />
        <Route path="/setup" element={<div data-testid="setup-page">setup</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Templates page', () => {
  beforeEach(() => {
    api.get.mockReset(); api.post.mockReset(); api.put.mockReset(); api.delete.mockReset();
    api.get.mockResolvedValue({ data: { templates: ROWS } });
    currentAuth = { ...defaultAuth, orgRole: 'owner', user: { ...defaultAuth.user, org_id: 100, is_super_admin: false, role: 'user' } };
  });
  afterEach(() => cleanup());

  it('groups yours / starters / community and renders summaries only', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('template-card-1')).toBeInTheDocument());
    expect(within(screen.getByTestId('template-card-1')).getByText('Private')).toBeInTheDocument();
    expect(within(screen.getByTestId('template-card-2')).getByText('Starter')).toBeInTheDocument();
    expect(within(screen.getByTestId('template-card-3')).getByText('Community')).toBeInTheDocument();
    expect(screen.getByText(/Trial → Demo → Won → Lost/)).toBeInTheDocument();
    expect(screen.getByText(/2 fields · 2 automations · 1 view · used 12×/)).toBeInTheDocument();
    // Manage actions only on ours.
    expect(within(screen.getByTestId('template-card-1')).getByRole('button', { name: /Share publicly/i })).toBeInTheDocument();
    expect(within(screen.getByTestId('template-card-2')).queryByRole('button', { name: /Share publicly|Make private|Delete/i })).not.toBeInTheDocument();
    // No super-admin button for a plain owner.
    expect(screen.queryByRole('button', { name: /starter gallery/i })).not.toBeInTheDocument();
  });

  it('"Use this template" hands off to /setup?template=wt:<id>', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('template-card-2')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('template-card-2')).getByRole('button', { name: /Use this template/i }));
    await waitFor(() => expect(screen.getByTestId('setup-page')).toBeInTheDocument());
  });

  it('owner saves the current workspace as a snapshot template; ?save=1 opens the dialog', async () => {
    api.post.mockResolvedValueOnce({ data: { template: { id: 4, name: 'Our RFQ process' } } });
    renderPage('/templates?save=1');
    await waitFor(() => expect(screen.getByTestId('template-name')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('template-name'), { target: { value: 'Our RFQ process' } });
    fireEvent.click(screen.getByTestId('template-public'));
    fireEvent.click(screen.getByTestId('save-template'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/workspace-templates', expect.objectContaining({ name: 'Our RFQ process', is_public: true, source: 'snapshot' })));
    await waitFor(() => expect(screen.getByText(/Saved "Our RFQ process"/)).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(2); // initial + reload
  });

  it('share toggle and delete go through PUT/DELETE, delete asks first', async () => {
    api.put.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: { ok: true } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('template-card-1')).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId('template-card-1')).getByRole('button', { name: /Share publicly/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/workspace-templates/1', { is_public: true }));
    fireEvent.click(within(screen.getByTestId('template-card-1')).getByRole('button', { name: /Delete Our process/i }));
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/workspace-templates/1'));
  });

  it('member sees the gallery but no save/manage controls', async () => {
    currentAuth = { ...defaultAuth, orgRole: 'member', user: { ...defaultAuth.user, org_id: 200, org_role: 'member', is_super_admin: false, role: 'user' } };
    renderPage();
    await waitFor(() => expect(screen.getByTestId('template-card-2')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Save current workspace/i })).not.toBeInTheDocument();
    expect(screen.getByText(/An owner or admin can save/)).toBeInTheDocument();
  });

  it('super-admin gets the generate button and it calls the endpoint', async () => {
    currentAuth = { ...defaultAuth, orgRole: 'owner', user: { ...defaultAuth.user, org_id: 100, is_super_admin: true } };
    api.post.mockResolvedValueOnce({ data: { ok: true, generated: [{ slug: 'saas' }], failed: [] } });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('template-card-2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Regenerate starter gallery/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/workspace-templates/generate-platform', {}));
    await waitFor(() => expect(screen.getByText(/Generated 1 starter template\./)).toBeInTheDocument());
  });
});

describe('Setup ?template= parser', () => {
  it('maps static ids and wt:<id>, rejects junk', () => {
    expect(parseTemplateParam('manufacturer_rep')).toEqual({ kind: 'static', id: 'manufacturer_rep' });
    expect(parseTemplateParam('wt:42')).toEqual({ kind: 'saved', id: 42 });
    expect(parseTemplateParam('wt:abc')).toBeNull();
    expect(parseTemplateParam('<script>')).toBeNull();
    expect(parseTemplateParam('')).toBeNull();
    expect(parseTemplateParam(null)).toBeNull();
  });
});
