// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 John Coles - The Open CRM
// This file is part of The Open CRM, free software under the GNU AGPL v3.0 or
// later. See the LICENSE file at the repository root, or
// https://www.gnu.org/licenses/agpl-3.0.html. Distributed WITHOUT ANY WARRANTY.

// Spec for the Segments page. The load-bearing guarantee under test is the
// CONFIRM-FIRST contract: a bulk action must NOT call the write endpoint until
// the user accepts a dialog that states the exact affected-member count. Also
// covers the warm empty state and that a segment's members render on select.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';

import { defaultAuth } from '../test-utils';

// Named-export mock of ../api. Segments.js imports { segments, LIFECYCLE_STAGES,
// api }. `api` is only used for GET /org (owner dropdown), so a bare resolver
// is fine.
const segmentsApi = vi.hoisted(() => ({
  list:    vi.fn(() => Promise.resolve([])),
  preview: vi.fn(() => Promise.resolve({ count: 0, sample: [] })),
  members: vi.fn(() => Promise.resolve({ total: 0, members: [], entity_type: 'company' })),
  create:  vi.fn(() => Promise.resolve({})),
  update:  vi.fn(() => Promise.resolve({})),
  remove:  vi.fn(() => Promise.resolve({})),
  bulk:    vi.fn(() => Promise.resolve({ action: 'set_lifecycle_stage', affected: 0 })),
  get:     vi.fn(() => Promise.resolve({})),
  schema:  vi.fn(() => Promise.resolve({})),
}));
const api = vi.hoisted(() => ({
  get: vi.fn(() => Promise.resolve({ data: { members: [] } })),
}));
vi.mock('../api', () => ({
  default: api,
  api,
  segments: segmentsApi,
  LIFECYCLE_STAGES: ['prospect', 'onboarding', 'active', 'at_risk', 'renewed', 'churned'],
}));

vi.mock('../AuthContext', () => ({ useAuth: () => defaultAuth }));
vi.mock('../components/Nav', () => ({ default: () => <nav data-testid="nav-stub" /> }));

import Segments from './Segments';

function renderPage() {
  return render(
    <MemoryRouter>
      <Segments />
    </MemoryRouter>
  );
}

const SAVED_SEGMENT = {
  id: 5,
  org_id: 100,
  name: 'At-risk manufacturers',
  entity_type: 'company',
  criteria: [{ field: 'lifecycle_stage', op: 'eq', value: 'at_risk' }],
};

describe('Segments', () => {
  beforeEach(() => {
    Object.values(segmentsApi).forEach((fn) => fn.mockReset && fn.mockReset());
    api.get.mockReset();
    // Sensible defaults; individual tests override.
    segmentsApi.list.mockResolvedValue([]);
    segmentsApi.preview.mockResolvedValue({ count: 0, sample: [] });
    segmentsApi.members.mockResolvedValue({ total: 0, members: [], entity_type: 'company' });
    segmentsApi.bulk.mockResolvedValue({ action: 'set_lifecycle_stage', affected: 3 });
    api.get.mockResolvedValue({ data: { members: [] } });
  });
  afterEach(() => cleanup());

  it('shows the warm empty state when there are no saved segments', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/No segments yet/i)).toBeInTheDocument());
  });

  it('loads and renders a saved segment on select', async () => {
    segmentsApi.list.mockResolvedValue([SAVED_SEGMENT]);
    segmentsApi.members.mockResolvedValue({
      total: 3,
      members: [{ id: 1, name: 'Acme Co', industry: 'Manufacturing', lifecycle_stage: 'at_risk', status: 'active' }],
      entity_type: 'company',
    });

    renderPage();
    // Segment appears in the saved list.
    const segBtn = await screen.findByText('At-risk manufacturers');
    fireEvent.click(segBtn);

    // Members load and the member row renders.
    await waitFor(() => expect(screen.getByText('Acme Co')).toBeInTheDocument());
    expect(segmentsApi.members).toHaveBeenCalledWith(5, { limit: 50 });
  });

  it('is CONFIRM-FIRST: choosing + running a bulk action does NOT write until the dialog is accepted', async () => {
    segmentsApi.list.mockResolvedValue([SAVED_SEGMENT]);
    segmentsApi.members.mockResolvedValue({
      total: 3,
      members: [{ id: 1, name: 'Acme Co', industry: 'Manufacturing', lifecycle_stage: 'at_risk', status: 'active' }],
      entity_type: 'company',
    });

    renderPage();
    fireEvent.click(await screen.findByText('At-risk manufacturers'));
    await waitFor(() => expect(screen.getByText('Acme Co')).toBeInTheDocument());

    // Choose the bulk action + a target stage.
    fireEvent.change(screen.getByLabelText(/Bulk action/i), { target: { value: 'set_lifecycle_stage' } });
    fireEvent.change(screen.getByLabelText(/New lifecycle stage/i), { target: { value: 'active' } });

    // Click Run — this must ONLY open the confirm dialog, not write.
    fireEvent.click(screen.getByRole('button', { name: /^Run/i }));

    // The dialog states the exact affected count. Still no write.
    await waitFor(() => expect(screen.getByText(/Confirm bulk action/i)).toBeInTheDocument());
    expect(screen.getByText(/This will affect/i)).toBeInTheDocument();
    expect(segmentsApi.bulk).not.toHaveBeenCalled();

    // Accept — NOW it writes, with the chosen action + params.
    fireEvent.click(screen.getByRole('button', { name: /Yes, update 3 record/i }));
    await waitFor(() => expect(segmentsApi.bulk).toHaveBeenCalledTimes(1));
    expect(segmentsApi.bulk).toHaveBeenCalledWith(5, 'set_lifecycle_stage', { lifecycle_stage: 'active' });
  });

  it('lets the user cancel the confirm dialog without writing', async () => {
    segmentsApi.list.mockResolvedValue([SAVED_SEGMENT]);
    segmentsApi.members.mockResolvedValue({
      total: 3,
      members: [{ id: 1, name: 'Acme Co', industry: 'Manufacturing', lifecycle_stage: 'at_risk', status: 'active' }],
      entity_type: 'company',
    });

    renderPage();
    fireEvent.click(await screen.findByText('At-risk manufacturers'));
    await waitFor(() => expect(screen.getByText('Acme Co')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/Bulk action/i), { target: { value: 'set_lifecycle_stage' } });
    fireEvent.change(screen.getByLabelText(/New lifecycle stage/i), { target: { value: 'active' } });
    fireEvent.click(screen.getByRole('button', { name: /^Run/i }));

    await waitFor(() => expect(screen.getByText(/Confirm bulk action/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByText(/Confirm bulk action/i)).not.toBeInTheDocument());
    expect(segmentsApi.bulk).not.toHaveBeenCalled();
  });
});
