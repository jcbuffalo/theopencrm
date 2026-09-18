// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Smoke spec for /settings/pipeline (per-org editable stages).
//
// An org admin sees the effective stages from GET /api/pipelines, can rename
// a stage, and Save PUTs the full stage list; removing a stage that holds
// deals asks where they go before Save is enabled; a member gets read-only.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
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

import PipelineSettings from './PipelineSettings';

const STAGES = [
  { id: 'lead',        label: 'Lead',        tone: 'slate',  phase: null, is_won: false, is_lost: false },
  { id: 'qualified',   label: 'Qualified',   tone: 'blue',   phase: null, is_won: false, is_lost: false },
  { id: 'proposal',    label: 'Proposal',    tone: 'cyan',   phase: null, is_won: false, is_lost: false },
  { id: 'closed_won',  label: 'Closed Won',  tone: 'green',  phase: null, is_won: true,  is_lost: false },
  { id: 'closed_lost', label: 'Closed Lost', tone: 'red',    phase: null, is_won: false, is_lost: true },
];

function pipelinePayload(overrides = {}) {
  return {
    profile: 'generic',
    is_custom: false,
    name: 'Pipeline',
    stages: STAGES,
    phases: [{ id: 'pipeline', label: 'Pipeline', stage_ids: STAGES.map(s => s.id) }],
    default_stage: 'lead',
    deal_counts: { proposal: 3 },
    can_edit: true,
    tones: ['slate', 'blue', 'cyan', 'green', 'red', 'gray'],
    max_stages: 15,
    default_stages: STAGES,
    ...overrides,
  };
}

const adminAuth = {
  ...defaultAuth,
  user: { ...defaultAuth.user, org_role: 'admin', is_super_admin: false, is_admin: false },
  isAdmin: false,
  adminRole: null,
  orgRole: 'admin',
  refreshPipeline: vi.fn(() => Promise.resolve(null)),
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/pipeline']}>
      <PipelineSettings />
    </MemoryRouter>
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.put.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(() => Promise.resolve({ data: pipelinePayload() }));
  api.put.mockImplementation(() => Promise.resolve({ data: { ok: true, pipeline: pipelinePayload({ is_custom: true }), moved: [] } }));
  currentAuth = adminAuth;
});

afterEach(() => cleanup());

describe('PipelineSettings', () => {
  it('renders the effective stages with deal counts and the default badge', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Proposal')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/pipelines');
    expect(screen.getByText('Profile default')).toBeInTheDocument();
    expect(screen.getByText('3 deals')).toBeInTheDocument();
    // Slugs are shown under the names.
    expect(screen.getByText('closed_won')).toBeInTheDocument();
    // Save is disabled until something changes.
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('renaming a stage enables Save and PUTs the full stage list', async () => {
    renderPage();
    const input = await screen.findByDisplayValue('Proposal');
    fireEvent.change(input, { target: { value: 'Quote Sent' } });
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = api.put.mock.calls[0];
    expect(path).toBe('/pipelines');
    expect(body.stages).toHaveLength(5);
    expect(body.stages[2]).toMatchObject({ id: 'proposal', label: 'Quote Sent' });
    expect(body.moveDealsTo).toBeUndefined();
    await waitFor(() => expect(adminAuth.refreshPipeline).toHaveBeenCalled());
    expect(await screen.findByText(/Pipeline saved/)).toBeInTheDocument();
  });

  it('removing a stage that holds deals asks where they go before Save; then sends moveDealsTo', async () => {
    renderPage();
    await screen.findByDisplayValue('Proposal');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Proposal' }));
    expect(screen.queryByDisplayValue('Proposal')).not.toBeInTheDocument();
    expect(screen.getByText('Deals to move')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled();
    const select = screen.getByLabelText('Move proposal deals to');
    fireEvent.change(select, { target: { value: 'qualified' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const body = api.put.mock.calls[0][1];
    expect(body.stages.map(s => s.id)).toEqual(['lead', 'qualified', 'closed_won', 'closed_lost']);
    expect(body.moveDealsTo).toEqual({ proposal: 'qualified' });
  });

  it('unmarking the only Won stage blocks Save with a validation message', async () => {
    renderPage();
    await screen.findByDisplayValue('Closed Won');
    const list = screen.getByRole('list', { name: 'Pipeline stages' });
    const wonRow = within(list).getAllByRole('listitem')[3];
    fireEvent.click(within(wonRow).getByRole('button', { name: 'Won' }));
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    expect(screen.getByText('Mark at least one stage as Won.')).toBeInTheDocument();
  });

  it('adding a stage derives its slug from the name', async () => {
    renderPage();
    await screen.findByDisplayValue('Lead');
    fireEvent.click(screen.getByRole('button', { name: 'Add stage' }));
    const input = screen.getByLabelText('Stage 6 name');
    fireEvent.change(input, { target: { value: 'Demo Booked' } });
    expect(screen.getByText('demo_booked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1].stages[5]).toMatchObject({ id: 'demo_booked', label: 'Demo Booked' });
  });

  it('a member sees the stages read-only', async () => {
    currentAuth = { ...memberAuth, orgRole: 'member', refreshPipeline: vi.fn() };
    api.get.mockImplementation(() => Promise.resolve({ data: pipelinePayload({ can_edit: false }) }));
    renderPage();
    expect(await screen.findByDisplayValue('Lead')).toBeDisabled();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });
});
