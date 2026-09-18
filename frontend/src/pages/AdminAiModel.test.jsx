// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the per-org AI model + reasoning effort admin page (PR #16).
//
// The page is org-admin gated, hydrates from GET /admin/ai-model, lets the
// admin pick a model / effort, then PATCHes /admin/ai-model on Save. A second
// path is "Reset to default" which PATCHes with explicit nulls.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth, memberAuth, mockApi } from '../test-utils';

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

vi.mock('../components/Nav', () => ({
  default: () => <nav data-testid="nav-stub" />,
}));

import AdminAiModel from './AdminAiModel';

const SETTINGS_FIXTURE = {
  model: 'claude-sonnet-4-5',
  effort: 'medium',
  default_model: 'claude-sonnet-4-5',
  default_effort: 'medium',
  env_override: false,
  valid_models: [
    { id: 'claude-haiku-4-5',  label: 'Haiku 4.5' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
    { id: 'claude-opus-4-5',   label: 'Opus 4.5' },
  ],
  valid_efforts: ['low', 'medium', 'high'],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminAiModel />
    </MemoryRouter>
  );
}

describe('AdminAiModel', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockReset && fn.mockReset());
    api.get.mockResolvedValue({ data: SETTINGS_FIXTURE });
    api.patch.mockResolvedValue({ data: SETTINGS_FIXTURE });
    currentAuth = defaultAuth;
  });
  afterEach(() => cleanup());

  it('blocks non-org-admin users with an access banner', async () => {
    currentAuth = { ...memberAuth, isAdmin: false };
    renderPage();
    expect(screen.getByText(/Org owner or admin access required/i)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('renders model + effort dropdowns from GET /admin/ai-model', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Sonnet 4\.5/i)).toBeInTheDocument());
    // All three models surfaced as options.
    expect(screen.getByText(/Haiku 4\.5/i)).toBeInTheDocument();
    expect(screen.getByText(/Opus 4\.5/i)).toBeInTheDocument();
    // All three effort options.
    const efforts = screen.getAllByRole('option').map(o => o.textContent);
    expect(efforts.some(t => t.includes('low'))).toBe(true);
    expect(efforts.some(t => t.includes('medium'))).toBe(true);
    expect(efforts.some(t => t.includes('high'))).toBe(true);
  });

  it('shows the env_override banner when the backend says one is active', async () => {
    api.get.mockResolvedValueOnce({ data: { ...SETTINGS_FIXTURE, env_override: true } });
    renderPage();
    await waitFor(() => expect(screen.getByText(/ANTHROPIC_MODEL/)).toBeInTheDocument());
  });

  it('disables Save until a dropdown is changed (dirty state)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/i })).toBeDisabled());

    // Flip the model dropdown — Save should become enabled.
    const modelSelect = screen.getAllByRole('combobox')[0];
    fireEvent.change(modelSelect, { target: { value: 'claude-opus-4-5' } });
    expect(screen.getByRole('button', { name: /Save changes/i })).not.toBeDisabled();
  });

  it('PATCHes with the new model + effort on Save', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBe(2));

    const [modelSelect, effortSelect] = screen.getAllByRole('combobox');
    fireEvent.change(modelSelect,  { target: { value: 'claude-opus-4-5' } });
    fireEvent.change(effortSelect, { target: { value: 'high' } });

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/admin/ai-model', {
        model:  'claude-opus-4-5',
        effort: 'high',
      })
    );
  });

  it('Reset to default PATCHes with explicit nulls', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Reset to default/i)).toBeInTheDocument());

    fireEvent.click(screen.getByText(/Reset to default/i));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/admin/ai-model', { model: null, effort: null })
    );
  });

  it('surfaces an error banner when the initial load fails', async () => {
    api.get.mockReset();
    api.get.mockRejectedValueOnce({ response: { data: { error: 'load broke' } } });
    renderPage();
    await waitFor(() => expect(screen.getByText('load broke')).toBeInTheDocument());
  });
});
